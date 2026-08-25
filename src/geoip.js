const maxmind = require("maxmind");
const { IP2Location } = require("ip2location-nodejs");
const { IP2Proxy } = require("ip2proxy-nodejs");
const path = require("path");
const fs = require("fs");
const { vpnHostingProviders, vpnASNs } = require("./providers.js");

// --- DATABASE PATHS ---
const cityDbPath =
  process.env.CITY_DB_PATH ||
  path.join(__dirname, "..", "db", "GeoLite2-City.mmdb");
const asnDbPath =
  process.env.ASN_DB_PATH ||
  path.join(__dirname, "..", "db", "GeoLite2-ASN.mmdb");
const proxyDbPath =
  process.env.PROXY_DB_PATH ||
  path.join(__dirname, "..", "db", "IP2PROXY-LITE-PX11.BIN");
const db11Path =
  process.env.DB11_PATH ||
  path.join(__dirname, "..", "db", "IP2LOCATION-LITE-DB11.IPV6.BIN");
const ipinfoAsnDbPath =
  process.env.IPINFO_ASN_DB_PATH ||
  path.join(__dirname, "..", "db", "ipinfo-asn.mmdb");

let cityLookup, asnLookup, proxyLookup, db11Lookup, ipinfoAsnLookup;

function watchDatabase(filePath, reloadCallback, dbName) {
  if (!fs.existsSync(filePath)) return;

  let debounceTimer;
  fs.watch(filePath, (event) => {
    if (event === "rename" || event === "change") {
      clearTimeout(debounceTimer);

      debounceTimer = setTimeout(async () => {
        console.log(
          `♻️ Update detected for ${dbName}. Reloading into memory...`,
        );
        try {
          await reloadCallback();
          console.log(`✅ ${dbName} Hot-Reload Complete.`);
        } catch (err) {
          console.error(
            `❌ FAILED to hot-reload ${dbName}. Keeping previous version in memory. Error:`,
            err.message,
          );
        }
      }, 2000);
    }
  });
}

async function initGeoDb() {
  try {
    const loadCity = async () => {
      cityLookup = await maxmind.open(cityDbPath);
    };
    await loadCity();
    console.log(`✅ City DB loaded`);
    watchDatabase(cityDbPath, loadCity, "GeoLite2-City");

    try {
      const loadAsn = async () => {
        asnLookup = await maxmind.open(asnDbPath);
      };
      await loadAsn();
      console.log(`✅ ASN DB loaded`);
      watchDatabase(asnDbPath, loadAsn, "GeoLite2-ASN");
    } catch (e) {
      console.warn(`⚠️ ASN DB missing`);
    }

    try {
      const loadIpInfo = async () => {
        ipinfoAsnLookup = await maxmind.open(ipinfoAsnDbPath);
      };
      await loadIpInfo();
      console.log(`✅ IPinfo ASN DB loaded`);
      watchDatabase(ipinfoAsnDbPath, loadIpInfo, "IPinfo-ASN");
    } catch (e) {
      console.warn(`⚠️ IPinfo ASN DB missing`);
    }

    try {
      const loadDb11 = () => {
        const newDb11 = new IP2Location();
        newDb11.open(db11Path);
        db11Lookup = newDb11;
      };
      loadDb11();
      console.log(`✅ DB11 (Fallback) loaded`);
      watchDatabase(db11Path, loadDb11, "IP2Location-DB11");
    } catch (e) {
      console.warn(`⚠️ DB11 Error`);
    }

    try {
      const loadProxy = () => {
        const newProxy = new IP2Proxy();
        if (newProxy.open(proxyDbPath) === 0) {
          proxyLookup = newProxy;
        }
      };
      loadProxy();
      console.log(`✅ Proxy DB loaded`);
      watchDatabase(proxyDbPath, loadProxy, "IP2Proxy");
    } catch (e) {
      console.warn(`⚠️ Proxy DB error`);
    }
  } catch (err) {
    console.error("❌ DB Error:", err);
  }
}

function getGeoData(ip) {
  // 1. Reserved / Local / Docker IP Checks
  const isLocal =
    ip === "::1" ||
    ip === "127.0.0.1" ||
    ip.startsWith("192.168.") ||
    ip.startsWith("10.") ||
    ip.startsWith("169.254.") ||
    ip.startsWith("fc00:") ||
    ip.startsWith("fd00:");
  let isDocker = false;
  if (ip.startsWith("172.")) {
    const secondOctet = parseInt(ip.split(".")[1], 10);
    if (secondOctet >= 16 && secondOctet <= 31) isDocker = true;
  }
  if (isLocal || isDocker) {
    return {
      ip,
      country: "Reserved",
      country_code: "XX",
      city: "Local Network",
      asn: "N/A",
      org: "Localhost",
      is_proxy: false,
      proxy_type: "Local",
      usage_type: "RES",
      threat: "None",
      provider: "N/A",
    };
  }

  try {
    // --- DATA LOOKUPS ---
    const cityData = cityLookup ? cityLookup.get(ip) : null;
    const asnData = asnLookup ? asnLookup.get(ip) : null;
    const proxyData = proxyLookup ? proxyLookup.getAll(ip) : {};
    const ipinfoData = ipinfoAsnLookup ? ipinfoAsnLookup.get(ip) : null;

    let orgName = asnData
      ? asnData.autonomous_system_organization
      : "Unknown ISP";
    if (orgName === "Unknown ISP" && ipinfoData && ipinfoData.name) {
      orgName = ipinfoData.name;
    }
    const asnNumber = asnData
      ? `AS${asnData.autonomous_system_number}`
      : ipinfoData
        ? ipinfoData.asn
        : "Unknown";

    // DB11 Fallback
    const db11Data = db11Lookup ? db11Lookup.getAll(ip) : {};

    // Helper: Prioritize MaxMind -> DB11 -> Unknown
    const pick = (primary, secondary) => {
      if (primary && primary !== "Unknown" && primary !== "") return primary;
      if (
        secondary &&
        secondary !== "-" &&
        secondary !== "This parameter is unavailable for selected data file."
      )
        return secondary;
      return "Unknown";
    };

    // --- USAGE TYPE DETECTION ---
    let rawUsage = proxyData.usageType;
    if (!rawUsage || rawUsage === "-" || rawUsage === "RP") {
      rawUsage = "Standard";
    }
    const usageMap = {
      ISP: "Residential",
      MOB: "Mobile Data",
      COM: "Commercial",
      ORG: "Organization",
      EDU: "University",
      GOV: "Government",
      DCH: "Datacenter",
      CDN: "CDN",
      SES: "Search Engine Spider",
      Standard: "Standard ISP",
    };
    let usageType = usageMap[rawUsage] || rawUsage;

    // If it's a "Standard ISP" (unknown) but matches a Cloud Provider, rename it.
    if (usageType === "Standard ISP") {
      if (
        vpnHostingProviders.low.some((p) =>
          orgName.toLowerCase().includes(p.toLowerCase()),
        )
      ) {
        usageType = "Cloud Infrastructure";
      }
    }

    // --- PROXY DETECTION LOGIC ---
    let isProxy = false;
    let riskLabel = "No";

    // A) Check Database First (IP2Proxy LITE)
    if (proxyData && proxyData.isProxy === 1) {
      isProxy = true;
      const typeMap = {
        VPN: "VPN Service",
        DCH: "Datacenter",
        TOR: "Tor Node",
        PUB: "Public Proxy",
        SES: "Search Engine Spider",
      };
      riskLabel = typeMap[proxyData.proxyType] || proxyData.proxyType;
    }

    // B) Check IPinfo ASN Database
    if (!isProxy && ipinfoData && ipinfoData.type === "hosting") {
      isProxy = true;
      riskLabel = "Cloud/VPS Provider";
      usageType = "Datacenter";
    }

    // C) Fallback: Check Provider Lists
    if (!isProxy && orgName !== "Unknown ISP") {
      if (
        vpnHostingProviders.high.some((p) =>
          orgName.toLowerCase().includes(p.toLowerCase()),
        )
      ) {
        isProxy = true;
        riskLabel = "VPN Hosting (High Confidence)";
      } else if (
        vpnHostingProviders.medium.some((p) =>
          orgName.toLowerCase().includes(p.toLowerCase()),
        )
      ) {
        isProxy = true;
        riskLabel = "VPN Hosting (Medium Confidence)";
      } else if (
        vpnHostingProviders.low.some((p) =>
          orgName.toLowerCase().includes(p.toLowerCase()),
        )
      ) {
        if (
          usageType === "DCH" ||
          usageType === "Datacenter" ||
          usageType === "Cloud Infrastructure"
        ) {
          isProxy = true;
          riskLabel = "Cloud Hosting (Low Confidence)";
        }
      }
    }

    // D) ASN-based detection (High-Risk Networks ONLY)
    if (!isProxy && vpnASNs.includes(asnNumber)) {
      isProxy = true;
      riskLabel = "VPN ASN Match";
    }

    // --- THREAT & PROVIDER SANITIZATION ---
    let threat = proxyData.threat || "-";
    let provider = proxyData.provider || "-";

    if (threat === "-") threat = "None";
    if (provider === "-") provider = "N/A";

    if (isProxy && riskLabel !== "No") {
      if (usageType === "Standard ISP" || usageType === "Standard")
        usageType = "Datacenter";
      if (provider === "N/A") provider = orgName;

      if (threat === "None") {
        if (riskLabel.includes("High") || riskLabel === "VPN ASN Match")
          threat = "High (VPN Hosting)";
        else if (riskLabel.includes("Medium"))
          threat = "Medium (Hosting Provider)";
        else threat = "Low (Cloud Provider)";
      }
    }

    // --- FINAL MERGE ---
    let lat = cityData?.location?.latitude || 0;
    let long = cityData?.location?.longitude || 0;

    if (lat === 0 && db11Data.latitude && db11Data.latitude !== "0.000000") {
      lat = parseFloat(db11Data.latitude);
      long = parseFloat(db11Data.longitude);
    }

    return {
      ip,
      country: pick(cityData?.country?.names?.en, db11Data.country_long),
      country_code: pick(cityData?.country?.iso_code, db11Data.country_short),
      city: pick(cityData?.city?.names?.en, db11Data.city),
      region: pick(cityData?.subdivisions?.[0]?.names?.en, db11Data.region),
      timezone: pick(cityData?.location?.time_zone, db11Data.time_zone),
      coordinates: `${lat}, ${long}`,
      latitude: lat,
      longitude: long,
      zip:
        db11Data.zip_code && db11Data.zip_code !== "-"
          ? db11Data.zip_code
          : "N/A",
      asn: asnNumber,
      org: orgName,
      is_proxy: isProxy,
      proxy_type: riskLabel,
      usage_type: usageType,
      threat: threat,
      provider: provider,
    };
  } catch (err) {
    console.error("Geo lookup failed for IP:", ip, err);
    return { ip, error: "Lookup Failed" };
  }
}

module.exports = { initGeoDb, getGeoData };
