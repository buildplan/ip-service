const maxmind = require("maxmind");
const { IP2Location } = require("ip2location-nodejs");
const { IP2Proxy } = require("ip2proxy-nodejs");
const path = require("path");
const fs = require("fs");
const { vpnHostingProviders, vpnASNs } = require("./providers.js");

// --- DATABASE PATHS ---
function getDbPath(envVar, defaultFilename, fallbackCandidate) {
  if (envVar) return envVar;
  const basePath = path.join(__dirname, "..", "db");
  const defaultPath = path.join(basePath, defaultFilename);
  if (fs.existsSync(defaultPath)) return defaultPath;
  if (fallbackCandidate) {
    const candidatePath = path.join(basePath, fallbackCandidate);
    if (fs.existsSync(candidatePath)) return candidatePath;
  }
  return defaultPath;
}

const cityDbPath =
  process.env.CITY_DB_PATH ||
  path.join(__dirname, "..", "db", "GeoLite2-City.mmdb");
const asnDbPath =
  process.env.ASN_DB_PATH ||
  path.join(__dirname, "..", "db", "GeoLite2-ASN.mmdb");
const proxyDbPath = getDbPath(
  process.env.PROXY_DB_PATH,
  "IP2PROXY-LITE-PX11.BIN",
  "IP2PROXY-LITE-PX11.IPV6.BIN",
);
const db11Path = getDbPath(
  process.env.DB11_PATH,
  "IP2LOCATION-LITE-DB11.IPV6.BIN",
  "IP2LOCATION-LITE-DB11.BIN",
);
const ipinfoAsnDbPath =
  process.env.IPINFO_ASN_DB_PATH ||
  path.join(__dirname, "..", "db", "ipinfo-asn.mmdb");

function cleanValue(val) {
  if (!val || typeof val !== "string") return null;
  const trimmed = val.trim();
  if (
    !trimmed ||
    trimmed === "-" ||
    trimmed === "?" ||
    trimmed === "N/A" ||
    trimmed === "RP" ||
    trimmed === "Unknown"
  ) {
    return null;
  }
  const upper = trimmed.toUpperCase();
  if (
    upper.includes("INVALID IP") ||
    upper.includes("INVALID_IP") ||
    upper.includes("MISSING") ||
    upper.includes("NOT SUPPORTED") ||
    upper.includes("NOT APPLICABLE") ||
    upper.includes("IPV6_NOT_SUPPORTED") ||
    upper.includes("IPV6 ADDRESS MISSING") ||
    upper.includes("UNAVAILABLE") ||
    upper.includes("INCORRECT IP2PROXY") ||
    upper.includes("INCORRECT IP2LOCATION")
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

function parseOffsetMinutes(str) {
  if (typeof str !== "string") return null;
  const trimmed = str.trim();
  if (!trimmed) return null;

  const hhmm = trimmed.match(/^([+-])(\d{1,2}):(\d{2})$/);
  if (hhmm) {
    const sign = hhmm[1] === "-" ? -1 : 1;
    const hours = Number(hhmm[2]);
    const mins = Number(hhmm[3]);
    if (hours > 14 || mins >= 60) return null;
    return sign * (hours * 60 + mins);
  }

  const gmt = trimmed.match(/^GMT(?:([+-])(\d{1,2})(?::(\d{2}))?)?$/);
  if (gmt) {
    if (!gmt[1]) return 0;
    const sign = gmt[1] === "-" ? -1 : 1;
    const hours = Number(gmt[2]);
    const mins = gmt[3] ? Number(gmt[3]) : 0;
    if (hours > 14 || mins >= 60) return null;
    return sign * (hours * 60 + mins);
  }

  return null;
}

const ianaOffsetCache = new Map();
const JAN_SAMPLE_DATE = new Date("2026-01-15T00:00:00Z");
const JUL_SAMPLE_DATE = new Date("2026-07-15T00:00:00Z");

function getIanaZoneOffsets(ianaZone) {
  if (typeof ianaZone !== "string" || !ianaZone.trim()) return null;
  const zone = ianaZone.trim();
  if (ianaOffsetCache.has(zone)) return ianaOffsetCache.get(zone);

  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      timeZoneName: "shortOffset",
    });
    const offsets = new Set();
    for (const sampleDate of [JAN_SAMPLE_DATE, JUL_SAMPLE_DATE]) {
      const part = fmt
        .formatToParts(sampleDate)
        .find((p) => p.type === "timeZoneName");
      const mins = part ? parseOffsetMinutes(part.value) : null;
      if (mins !== null) offsets.add(mins);
    }
    const result = offsets.size > 0 ? offsets : null;
    ianaOffsetCache.set(zone, result);
    return result;
  } catch (_) {
    ianaOffsetCache.set(zone, null);
    return null;
  }
}

function isIanaTimezoneCompatible(ianaZone, db11Offset) {
  const offsets = getIanaZoneOffsets(ianaZone);
  if (!offsets) return false;
  const db11Minutes = parseOffsetMinutes(db11Offset);
  if (db11Minutes === null) return true;
  return offsets.has(db11Minutes);
}

function extractMaxMindLocation(cityData) {
  const coords = extractCoordinates(
    cityData?.location?.latitude,
    cityData?.location?.longitude,
  );
  return {
    country: cleanValue(cityData?.country?.names?.en),
    countryCode: cleanValue(cityData?.country?.iso_code),
    city: cleanValue(cityData?.city?.names?.en),
    region: cleanValue(cityData?.subdivisions?.[0]?.names?.en),
    timezone: cleanValue(cityData?.location?.time_zone),
    zip: cleanValue(cityData?.postal?.code),
    lat: coords.lat,
    long: coords.long,
  };
}

function extractDb11Location(db11Data) {
  const coords = extractCoordinates(db11Data?.latitude, db11Data?.longitude);
  return {
    country: cleanValue(db11Data?.countryLong),
    countryCode: cleanValue(db11Data?.countryShort),
    city: cleanValue(db11Data?.city),
    region: cleanValue(db11Data?.region),
    timezone: cleanValue(db11Data?.timeZone),
    zip: cleanValue(db11Data?.zipCode),
    lat: coords.lat,
    long: coords.long,
  };
}

/**
 * Merge location records from GeoLite2-City (primary) and IP2Location DB11 (fallback)
 * without mixing incompatible fields across different cities or countries.
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
    const preferMmTimezone =
      sameCountry && isIanaTimezoneCompatible(mm.timezone, db11.timezone);
    return {
      country: (sameCountry && mm.country) || db11.country || "Unknown",
      country_code: db11.countryCode || "XX",
      city: db11.city,
      region: db11.region || (sameCountry ? mm.region : null) || "Unknown",
      timezone:
        (preferMmTimezone ? mm.timezone : null) ||
        db11.timezone ||
        (sameCountry ? mm.timezone : null) ||
        "Unknown",
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
    if (fs.existsSync(cityDbPath)) {
      const loadCity = async () => {
        cityLookup = await maxmind.open(cityDbPath);
      };
      await loadCity();
      console.log(`✅ City DB loaded`);
      watchDatabase(cityDbPath, loadCity, "GeoLite2-City");
    } else {
      console.warn(`⚠️ City DB missing at ${cityDbPath}`);
    }
  } catch (e) {
    console.warn(`⚠️ City DB error:`, e.message);
  }

  try {
    if (fs.existsSync(asnDbPath)) {
      const loadAsn = async () => {
        asnLookup = await maxmind.open(asnDbPath);
      };
      await loadAsn();
      console.log(`✅ ASN DB loaded`);
      watchDatabase(asnDbPath, loadAsn, "GeoLite2-ASN");
    } else {
      console.warn(`⚠️ ASN DB missing at ${asnDbPath}`);
    }
  } catch (e) {
    console.warn(`⚠️ ASN DB error:`, e.message);
  }

  try {
    if (fs.existsSync(ipinfoAsnDbPath)) {
      const loadIpInfo = async () => {
        ipinfoAsnLookup = await maxmind.open(ipinfoAsnDbPath);
      };
      await loadIpInfo();
      console.log(`✅ IPinfo ASN DB loaded`);
      watchDatabase(ipinfoAsnDbPath, loadIpInfo, "IPinfo-ASN");
    } else {
      console.warn(`⚠️ IPinfo ASN DB missing at ${ipinfoAsnDbPath}`);
    }
  } catch (e) {
    console.warn(`⚠️ IPinfo ASN DB error:`, e.message);
  }

  try {
    if (fs.existsSync(db11Path)) {
      const loadDb11 = () => {
        const newDb11 = new IP2Location();
        newDb11.open(db11Path);
        db11Lookup = newDb11;
      };
      loadDb11();
      console.log(`✅ DB11 (Fallback) loaded`);
      watchDatabase(db11Path, loadDb11, "IP2Location-DB11");
    } else {
      console.warn(`⚠️ DB11 DB missing at ${db11Path}`);
    }
  } catch (e) {
    console.warn(`⚠️ DB11 error:`, e.message);
  }

  try {
    if (fs.existsSync(proxyDbPath)) {
      const loadProxy = () => {
        const newProxy = new IP2Proxy();
        if (newProxy.open(proxyDbPath) === 0) {
          proxyLookup = newProxy;
        }
      };
      loadProxy();
      if (proxyLookup) {
        console.log(`✅ Proxy DB loaded`);
        watchDatabase(proxyDbPath, loadProxy, "IP2Proxy");
      } else {
        console.warn(`⚠️ Proxy DB failed to open at ${proxyDbPath}`);
      }
    } else {
      console.warn(`⚠️ Proxy DB missing at ${proxyDbPath}`);
    }
  } catch (e) {
    console.warn(`⚠️ Proxy DB error:`, e.message);
  }
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
      proxy_type: "No",
      usage_type: "Standard ISP",
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
      region: "Local Network",
      timezone: "Local",
      coordinates: "0, 0",
      latitude: 0,
      longitude: 0,
      zip: "N/A",
      asn: "N/A",
      org: "Localhost",
      network: "N/A",
      is_proxy: false,
      proxy_type: "Local",
      usage_type: "RES",
      threat: "None",
      provider: "N/A",
    };
  }

  try {
    // --- DATA LOOKUPS ---
    let cityData = null;
    if (cityLookup) {
      try {
        cityData = cityLookup.get(ip);
      } catch (e) {
        cityData = null;
      }
    }

    let asnData = null;
    let asnPrefix = null;
    if (asnLookup) {
      try {
        if (typeof asnLookup.getWithPrefixLength === "function") {
          const result = asnLookup.getWithPrefixLength(ip);
          if (result) {
            asnData = result[0];
            asnPrefix = result[1];
          }
        } else {
          asnData = asnLookup.get(ip);
        }
      } catch (e) {
        asnData = null;
      }
    }

    let proxyData = {};
    if (proxyLookup) {
      try {
        proxyData = proxyLookup.getAll(ip) || {};
      } catch (e) {
        proxyData = {};
      }
    }

    let ipinfoData = null;
    if (ipinfoAsnLookup) {
      try {
        ipinfoData = ipinfoAsnLookup.get(ip);
      } catch (e) {
        ipinfoData = null;
      }
    }

    // DB11 Fallback
    let db11Data = {};
    if (db11Lookup) {
      try {
        db11Data = db11Lookup.getAll(ip) || {};
      } catch (e) {
        db11Data = {};
      }
    }

    const orgName =
      cleanValue(asnData?.autonomous_system_organization) ||
      cleanValue(ipinfoData?.name) ||
      cleanValue(db11Data.isp) ||
      cleanValue(proxyData.isp) ||
      "Unknown ISP";

    let asnNumber = "Unknown";
    if (asnData && asnData.autonomous_system_number) {
      asnNumber = `AS${asnData.autonomous_system_number}`;
    } else if (cleanValue(ipinfoData?.asn)) {
      asnNumber = cleanValue(ipinfoData.asn);
    } else if (cleanValue(db11Data.asn)) {
      asnNumber = cleanValue(db11Data.asn);
    }

    let networkCidr = "N/A";
    if (cityData?.traits?.network) networkCidr = cityData.traits.network;
    else if (asnData?.network) networkCidr = asnData.network;
    else if (cleanValue(ipinfoData?.route)) networkCidr = cleanValue(ipinfoData.route);
    else if (cleanValue(ipinfoData?.network)) networkCidr = cleanValue(ipinfoData.network);
    else if (asnPrefix !== null && asnPrefix !== undefined) {
      if (ip.includes(":")) {
        networkCidr = `${ip}/${asnPrefix}`; // IPv6 approx
      } else {
        // basic IPv4 cidr masking
        const parts = ip.split(".").map(Number);
        const shift = 32 - asnPrefix;
        if (shift >= 32) {
          networkCidr = `0.0.0.0/${asnPrefix}`;
        } else {
          const ipInt =
            ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>>
            0;
          const mask = (~0 << shift) >>> 0;
          const baseInt = (ipInt & mask) >>> 0;
          const baseIp = [
            (baseInt >>> 24) & 255,
            (baseInt >>> 16) & 255,
            (baseInt >>> 8) & 255,
            baseInt & 255,
          ].join(".");
          networkCidr = `${baseIp}/${asnPrefix}`;
        }
      }
    }

    // --- SANITIZE IP2PROXY DATA ---
    const rawProxyType = cleanValue(proxyData.proxyType);
    const rawUsage = cleanValue(proxyData.usageType);
    const rawThreat = cleanValue(proxyData.threat);
    const rawProvider = cleanValue(proxyData.provider);
    const rawIsProxy = proxyData.isProxy === 1 || proxyData.isProxy === 2;

    // --- USAGE TYPE DETECTION ---
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
    };

    let usageType = null;
    if (rawUsage && usageMap[rawUsage]) {
      usageType = usageMap[rawUsage];
    } else if (rawUsage && rawUsage !== "Standard" && rawUsage !== "Standard ISP") {
      usageType = rawUsage;
    }

    // Fallback: Check IPinfo ASN classification if usageType is still unknown
    if (!usageType && ipinfoData && ipinfoData.type) {
      const ipinfoTypeMap = {
        isp: "Residential",
        hosting: "Datacenter",
        business: "Commercial",
        education: "University",
      };
      if (ipinfoTypeMap[ipinfoData.type]) {
        usageType = ipinfoTypeMap[ipinfoData.type];
      }
    }

    // Default if still unknown
    if (!usageType) {
      usageType = "Standard ISP";
    }

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
    if (rawIsProxy && rawProxyType) {
      const typeMap = {
        VPN: "VPN Service",
        DCH: "Datacenter",
        TOR: "Tor Node",
        PUB: "Public Proxy",
        WEB: "Web Proxy",
        SES: "Search Engine Spider",
        RES: "Residential Proxy",
        CPX: "Consumer Privacy Network",
        EPX: "Enterprise Proxy",
      };
      // WAP (Wireless Access Point) is not considered a proxy risk
      if (rawProxyType !== "WAP") {
        isProxy = true;
        riskLabel = typeMap[rawProxyType] || rawProxyType;
      }
    }

    // B) Check IPinfo ASN Database (Hosting / Cloud)
    if (!isProxy && ipinfoData && ipinfoData.type === "hosting") {
      isProxy = true;
      riskLabel = "Cloud/VPS Provider";
      usageType = "Datacenter";
    }

    // C) Fallback: Check Provider Lists against orgName
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
    let threat = "None";
    let provider = "N/A";

    if (isProxy && riskLabel !== "No") {
      if (usageType === "Standard ISP" || usageType === "Standard") {
        usageType = "Datacenter";
      }
      provider = rawProvider || orgName;

      if (rawThreat && rawThreat !== "None") {
        threat = rawThreat;
      } else {
        if (riskLabel.includes("High") || riskLabel === "VPN ASN Match") {
          threat = "High (VPN Hosting)";
        } else if (riskLabel.includes("Medium")) {
          threat = "Medium (Hosting Provider)";
        } else {
          threat = "Low (Cloud Provider)";
        }
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

module.exports = {
  initGeoDb,
  getGeoData,
  mergeLocationData,
  _internals: {
    cleanValue,
    isIanaTimezoneCompatible,
    mergeLocationData,
    setLookupsForTests: (mocks = {}) => {
      cityLookup = mocks.cityLookup ?? null;
      asnLookup = mocks.asnLookup ?? null;
      proxyLookup = mocks.proxyLookup ?? null;
      db11Lookup = mocks.db11Lookup ?? null;
      ipinfoAsnLookup = mocks.ipinfoAsnLookup ?? null;
    },
  },
};
