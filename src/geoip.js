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
    try {
      const loadCity = async () => {
        cityLookup = await maxmind.open(cityDbPath);
      };
      await loadCity();
      console.log(`✅ City DB loaded`);
      watchDatabase(cityDbPath, loadCity, "GeoLite2-City");
    } catch (e) {
      console.warn(`⚠️ City DB missing`);
    }

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
        if (!fs.existsSync(db11Path)) {
          throw new Error("DB11 file not found");
        }
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

const DB11_INVALID_VALUES = new Set([
  "-",
  "?",
  "Unknown",
  "INVALID_IP_ADDRESS",
  "MISSING_FILE",
  "IPV6_NOT_SUPPORTED",
]);

function cleanMaxMindValue(val) {
  if (typeof val !== "string") return null;
  const trimmed = val.trim();
  return trimmed && trimmed !== "Unknown" ? trimmed : null;
}

function cleanDb11Value(val) {
  if (typeof val !== "string") return null;
  const trimmed = val.trim();
  if (!trimmed || DB11_INVALID_VALUES.has(trimmed)) return null;
  if (
    trimmed.startsWith("This parameter is unavailable") ||
    trimmed.startsWith("This method is not applicable") ||
    trimmed.startsWith("Incorrect IP2Location")
  ) {
    return null;
  }
  return trimmed;
}

function normalizeLocationName(val) {
  if (typeof val !== "string") return "";
  return val
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

function extractCoordinates(rawLat, rawLong) {
  const lat = typeof rawLat === "number" ? rawLat : parseFloat(rawLat);
  const long = typeof rawLong === "number" ? rawLong : parseFloat(rawLong);
  if (
    Number.isFinite(lat) &&
    Number.isFinite(long) &&
    (lat !== 0 || long !== 0)
  ) {
    return { lat, long };
  }
  return { lat: null, long: null };
}

function extractMaxMindLocation(cityData) {
  const coords = extractCoordinates(
    cityData?.location?.latitude,
    cityData?.location?.longitude,
  );
  return {
    country: cleanMaxMindValue(cityData?.country?.names?.en),
    countryCode: cleanMaxMindValue(cityData?.country?.iso_code),
    city: cleanMaxMindValue(cityData?.city?.names?.en),
    region: cleanMaxMindValue(cityData?.subdivisions?.[0]?.names?.en),
    timezone: cleanMaxMindValue(cityData?.location?.time_zone),
    zip: cleanMaxMindValue(cityData?.postal?.code),
    lat: coords.lat,
    long: coords.long,
  };
}

function extractDb11Location(db11Data) {
  const coords = extractCoordinates(db11Data?.latitude, db11Data?.longitude);
  return {
    country: cleanDb11Value(db11Data?.countryLong),
    countryCode: cleanDb11Value(db11Data?.countryShort),
    city: cleanDb11Value(db11Data?.city),
    region: cleanDb11Value(db11Data?.region),
    timezone: cleanDb11Value(db11Data?.timeZone),
    zip: cleanDb11Value(db11Data?.zipCode),
    lat: coords.lat,
    long: coords.long,
  };
}

/**
 * Merge location records from GeoLite2-City (primary) and IP2Location DB11 (fallback)
 * without mixing incompatible fields (e.g. a city from one DB with a postal code from another).
 */
function mergeLocationData(cityData, db11Data) {
  const mm = extractMaxMindLocation(cityData);
  const db11 = extractDb11Location(db11Data);

  const sameCountry =
    mm.countryCode && db11.countryCode
      ? mm.countryCode.toUpperCase() === db11.countryCode.toUpperCase()
      : Boolean(
          mm.country &&
          db11.country &&
          normalizeLocationName(mm.country) ===
            normalizeLocationName(db11.country),
        );

  const sameCity =
    sameCountry &&
    Boolean(mm.city && db11.city) &&
    normalizeLocationName(mm.city) === normalizeLocationName(db11.city);

  const sameRegion =
    sameCountry &&
    Boolean(mm.region && db11.region) &&
    normalizeLocationName(mm.region) === normalizeLocationName(db11.region);

  if (mm.city) {
    const hasMmCoords = mm.lat !== null && mm.long !== null;
    const hasDbCoords = sameCity && db11.lat !== null && db11.long !== null;
    return {
      country: mm.country || (sameCountry ? db11.country : null) || "Unknown",
      country_code:
        mm.countryCode || (sameCountry ? db11.countryCode : null) || "XX",
      city: mm.city,
      region: mm.region || (sameCity ? db11.region : null) || "Unknown",
      timezone: mm.timezone || (sameCity ? db11.timezone : null) || "Unknown",
      latitude: hasMmCoords ? mm.lat : hasDbCoords ? db11.lat : 0,
      longitude: hasMmCoords ? mm.long : hasDbCoords ? db11.long : 0,
      zip: mm.zip || (sameCity ? db11.zip : null) || "N/A",
    };
  }

  if (db11.city) {
    const hasDbCoords = db11.lat !== null && db11.long !== null;
    return {
      country: (sameCountry && mm.country) || db11.country || "Unknown",
      country_code: db11.countryCode || "XX",
      city: db11.city,
      region: db11.region || (sameCountry ? mm.region : null) || "Unknown",
      timezone:
        db11.timezone || (sameCountry ? mm.timezone : null) || "Unknown",
      latitude: hasDbCoords ? db11.lat : 0,
      longitude: hasDbCoords ? db11.long : 0,
      zip: db11.zip || "N/A",
    };
  }

  if (mm.country || mm.countryCode) {
    const hasMmCoords = mm.lat !== null && mm.long !== null;
    const hasDbCoords =
      sameCountry && db11.lat !== null && db11.long !== null;
    return {
      country: mm.country || (sameCountry ? db11.country : null) || "Unknown",
      country_code:
        mm.countryCode || (sameCountry ? db11.countryCode : null) || "XX",
      city: "Unknown",
      region: mm.region || (sameCountry ? db11.region : null) || "Unknown",
      timezone:
        mm.timezone || (sameCountry ? db11.timezone : null) || "Unknown",
      latitude: hasMmCoords ? mm.lat : hasDbCoords ? db11.lat : 0,
      longitude: hasMmCoords ? mm.long : hasDbCoords ? db11.long : 0,
      zip: mm.zip || (sameRegion ? db11.zip : null) || "N/A",
    };
  }

  const hasDbCoords = db11.lat !== null && db11.long !== null;
  return {
    country: db11.country || "Unknown",
    country_code: db11.countryCode || "XX",
    city: "Unknown",
    region: db11.region || "Unknown",
    timezone: db11.timezone || "Unknown",
    latitude: hasDbCoords ? db11.lat : 0,
    longitude: hasDbCoords ? db11.long : 0,
    zip: db11.zip || "N/A",
  };
}

function getGeoData(ip) {
  if (typeof ip !== "string") {
    return {
      ip: String(ip || ""),
      country: "Unknown",
      country_code: "XX",
      city: "Unknown",
      region: "Unknown",
      timezone: "Unknown",
      coordinates: "0, 0",
      latitude: 0,
      longitude: 0,
      zip: "N/A",
      asn: "Unknown",
      org: "Unknown",
      network: "N/A",
      is_proxy: false,
      proxy_type: "Unknown",
      usage_type: "Unknown",
      threat: "None",
      provider: "N/A",
    };
  }

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
    let asnData = null;
    let asnPrefix = null;
    if (asnLookup) {
      if (typeof asnLookup.getWithPrefixLength === 'function') {
        const result = asnLookup.getWithPrefixLength(ip);
        if (result) {
          asnData = result[0];
          asnPrefix = result[1];
        }
      } else {
        asnData = asnLookup.get(ip);
      }
    }
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

    let networkCidr = "N/A";
    if (cityData && cityData.traits && cityData.traits.network) networkCidr = cityData.traits.network;
    else if (asnData && asnData.network) networkCidr = asnData.network;
    else if (ipinfoData && ipinfoData.route) networkCidr = ipinfoData.route;
    else if (ipinfoData && ipinfoData.network) networkCidr = ipinfoData.network;
    else if (asnPrefix !== null) {
      if (typeof ip === "string" && ip.includes(":")) {
        networkCidr = `${ip}/${asnPrefix}`; // IPv6 approx
      } else if (typeof ip === "string") {
        // basic IPv4 cidr masking
        const parts = ip.split('.').map(Number);
        const shift = 32 - asnPrefix;
        const ipInt = ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
        const mask = (~0 << shift) >>> 0;
        const baseInt = (ipInt & mask) >>> 0;
        const baseIp = [(baseInt >>> 24) & 255, (baseInt >>> 16) & 255, (baseInt >>> 8) & 255, baseInt & 255].join('.');
        networkCidr = `${baseIp}/${asnPrefix}`;
      }
    }

    // DB11 Fallback
    const db11Data = db11Lookup ? db11Lookup.getAll(ip) : {};

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
    const location = mergeLocationData(cityData, db11Data);

    return {
      ip,
      country: location.country,
      country_code: location.country_code,
      city: location.city,
      region: location.region,
      timezone: location.timezone,
      coordinates: `${location.latitude}, ${location.longitude}`,
      latitude: location.latitude,
      longitude: location.longitude,
      zip: location.zip,
      asn: asnNumber,
      org: orgName,
      network: networkCidr,
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

module.exports = { initGeoDb, getGeoData, mergeLocationData };
