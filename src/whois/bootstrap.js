const axios = require("axios");
const fs = require("fs");
const net = require("net");
const path = require("path");

const IANA_RDAP_URLS = {
  ipv4: "https://data.iana.org/rdap/ipv4.json",
  ipv6: "https://data.iana.org/rdap/ipv6.json",
};

const BOOTSTRAP_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours for in-memory IANA fetch

// Parsed IANA RDAP bootstrap tables
const bootstrapState = {
  ipv4: {
    entries: [],
    source: null, // "disk" | "remote"
    loadedAt: 0,
    watcher: null,
    inflight: null,
  },
  ipv6: {
    entries: [],
    source: null,
    loadedAt: 0,
    watcher: null,
    inflight: null,
  },
};

let bootstrapInitialized = false;

function getBootstrapPath(family) {
  if (family === "ipv6") {
    return (
      process.env.RDAP_IPV6_DB_PATH ||
      path.join(__dirname, "..", "..", "db", "rdap-ipv6.json")
    );
  }
  return (
    process.env.RDAP_IPV4_DB_PATH ||
    path.join(__dirname, "..", "..", "db", "rdap-ipv4.json")
  );
}

// --- IP PARSING & CIDR MATCHING (PURE JS, ZERO DEPS) ---

function ipv4ToBigInt(ip) {
  if (typeof ip !== "string") return null;
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let val = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const num = Number(part);
    if (num < 0 || num > 255) return null;
    val = (val << 8n) | BigInt(num);
  }
  return val;
}

function ipv6ToBigInt(ip) {
  if (typeof ip !== "string") return null;
  let addr = ip.toLowerCase();

  // Convert trailing embedded IPv4 (e.g. ::ffff:8.8.8.8) to two 16-bit hex groups
  const lastColon = addr.lastIndexOf(":");
  if (lastColon !== -1 && addr.slice(lastColon + 1).includes(".")) {
    const v4Part = addr.slice(lastColon + 1);
    const v4Val = ipv4ToBigInt(v4Part);
    if (v4Val === null) return null;
    const high = Number((v4Val >> 16n) & 0xffffn).toString(16);
    const low = Number(v4Val & 0xffffn).toString(16);
    addr = `${addr.slice(0, lastColon)}:${high}:${low}`;
  }

  const doubleColonParts = addr.split("::");
  if (doubleColonParts.length > 2) return null;

  let groups;
  if (doubleColonParts.length === 2) {
    const left = doubleColonParts[0] ? doubleColonParts[0].split(":") : [];
    const right = doubleColonParts[1] ? doubleColonParts[1].split(":") : [];
    const missing = 8 - (left.length + right.length);
    if (missing < 0) return null;
    groups = [...left, ...Array(missing).fill("0"), ...right];
  } else {
    groups = addr.split(":");
  }

  if (groups.length !== 8) return null;

  let val = 0n;
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    val = (val << 16n) | BigInt(parseInt(g, 16));
  }
  return val;
}

function normalizeQueryIp(rawIp) {
  if (typeof rawIp !== "string") return null;
  let ip = rawIp.trim();
  if (ip.startsWith("[") && ip.endsWith("]")) {
    ip = ip.slice(1, -1).trim();
  }
  const ipVersion = net.isIP(ip);
  if (!ipVersion) return null;

  // Unwrap IPv4-mapped IPv6 addresses (::ffff:a.b.c.d or ::ffff:xxxx:xxxx)
  if (ipVersion === 6) {
    const v6Val = ipv6ToBigInt(ip);
    if (v6Val !== null && v6Val >> 32n === 0xffffn) {
      const v4 = Number(v6Val & 0xffffffffn);
      return {
        ip: `${(v4 >>> 24) & 255}.${(v4 >>> 16) & 255}.${(v4 >>> 8) & 255}.${v4 & 255}`,
        version: 4,
      };
    }
  }

  return { ip, version: ipVersion };
}

function parseCidr(cidr, isV6) {
  if (typeof cidr !== "string" || !cidr.includes("/")) return null;
  const [addr, lenStr] = cidr.split("/");
  if (!/^\d+$/.test(lenStr)) return null;
  const bits = isV6 ? 128n : 32n;
  const prefixLen = Number(lenStr);
  if (!Number.isInteger(prefixLen) || prefixLen < 0 || prefixLen > Number(bits)) {
    return null;
  }
  const ipVal = isV6 ? ipv6ToBigInt(addr) : ipv4ToBigInt(addr);
  if (ipVal === null) return null;

  const shift = bits - BigInt(prefixLen);
  const fullMask = (1n << bits) - 1n;
  const mask = prefixLen === 0 ? 0n : (fullMask << shift) & fullMask;
  return {
    network: ipVal & mask,
    mask,
    prefixLen,
  };
}

function normalizeRdapBaseUrl(url) {
  if (typeof url !== "string") return null;
  const trimmed = url.trim();
  if (!trimmed.startsWith("https://")) return null;
  return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
}

function parseBootstrapServices(json, isV6) {
  if (!json || !Array.isArray(json.services)) return [];
  const entries = [];

  for (const service of json.services) {
    if (!Array.isArray(service) || service.length < 2) continue;
    const [cidrs, rawUrls] = service;
    if (!Array.isArray(cidrs) || !Array.isArray(rawUrls)) continue;

    // HTTPS-only per deployment security preference
    const urls = [...new Set(rawUrls.map(normalizeRdapBaseUrl).filter(Boolean))];
    if (urls.length === 0) continue;

    for (const cidr of cidrs) {
      const parsed = parseCidr(cidr, isV6);
      if (parsed) {
        entries.push({ ...parsed, urls });
      }
    }
  }

  // Sort by longest prefix first for deterministic longest-prefix match
  entries.sort((a, b) => b.prefixLen - a.prefixLen);
  return entries;
}

function matchBootstrapUrls(ip, version, entries) {
  if (!entries || entries.length === 0) return [];
  const isV6 = version === 6;
  const ipVal = isV6 ? ipv6ToBigInt(ip) : ipv4ToBigInt(ip);
  if (ipVal === null) return [];

  for (const entry of entries) {
    if ((ipVal & entry.mask) === entry.network) {
      return entry.urls;
    }
  }
  return [];
}

// --- IANA BOOTSTRAP LOADING & HOT-RELOAD ---

function loadBootstrapFromDisk(family, filePath) {
  try {
    if (!fs.existsSync(filePath)) return false;
    const raw = fs.readFileSync(filePath, "utf8");
    const json = JSON.parse(raw);
    const entries = parseBootstrapServices(json, family === "ipv6");
    if (entries.length === 0) {
      console.warn(`⚠️ RDAP ${family.toUpperCase()} bootstrap at ${filePath} had no valid entries.`);
      return false;
    }
    bootstrapState[family].entries = entries;
    bootstrapState[family].source = "disk";
    bootstrapState[family].loadedAt = Date.now();
    return true;
  } catch (err) {
    console.warn(`⚠️ Failed to load RDAP ${family.toUpperCase()} bootstrap from ${filePath}:`, err.message);
    return false;
  }
}

function watchBootstrapFile(family, filePath) {
  const state = bootstrapState[family];
  if (state.watcher) {
    try {
      state.watcher.close();
    } catch (_) {}
    state.watcher = null;
  }

  if (!fs.existsSync(filePath)) return;

  let debounceTimer;
  try {
    state.watcher = fs.watch(filePath, (event) => {
      if (event === "rename" || event === "change") {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          console.log(`♻️ Update detected for RDAP-${family.toUpperCase()} bootstrap. Reloading...`);
          if (loadBootstrapFromDisk(family, filePath)) {
            console.log(`✅ RDAP-${family.toUpperCase()} bootstrap Hot-Reload Complete.`);
          }
          // Re-attach watcher after atomic rename (new inode)
          if (event === "rename") {
            watchBootstrapFile(family, filePath);
          }
        }, 2000);
      }
    });
  } catch (err) {
    console.warn(`⚠️ Could not watch ${filePath}:`, err.message);
  }
}

function initWhoisBootstrap() {
  if (bootstrapInitialized) return;
  bootstrapInitialized = true;

  for (const family of ["ipv4", "ipv6"]) {
    const filePath = getBootstrapPath(family);
    if (loadBootstrapFromDisk(family, filePath)) {
      console.log(`✅ RDAP ${family.toUpperCase()} bootstrap loaded (${bootstrapState[family].entries.length} prefixes)`);
      watchBootstrapFile(family, filePath);
    }
  }
}

async function ensureBootstrapEntries(family, userAgent) {
  if (!bootstrapInitialized) {
    initWhoisBootstrap();
  }

  const state = bootstrapState[family];
  const filePath = getBootstrapPath(family);

  // If loaded from disk (hot-reloaded via fs.watch), always use it
  if (state.source === "disk" && state.entries.length > 0) {
    return state.entries;
  }

  // Check if the file appeared on disk after startup (e.g. cron script ran)
  if (fs.existsSync(filePath) && loadBootstrapFromDisk(family, filePath)) {
    watchBootstrapFile(family, filePath);
    return state.entries;
  }

  // Reuse in-memory remote copy if still fresh
  if (
    state.source === "remote" &&
    state.entries.length > 0 &&
    Date.now() - state.loadedAt < BOOTSTRAP_TTL_MS
  ) {
    return state.entries;
  }

  // Deduplicate concurrent fetches to IANA
  if (state.inflight) {
    return state.inflight;
  }

  state.inflight = (async () => {
    try {
      const res = await axios.get(IANA_RDAP_URLS[family], {
        timeout: 8000,
        headers: {
          Accept: "application/json",
          "User-Agent": userAgent,
        },
      });
      const entries = parseBootstrapServices(res.data, family === "ipv6");
      if (entries.length > 0) {
        state.entries = entries;
        state.source = "remote";
        state.loadedAt = Date.now();
        console.log(`✅ RDAP ${family.toUpperCase()} bootstrap fetched from IANA (${entries.length} prefixes)`);
      }
      return state.entries;
    } catch (err) {
      console.warn(`⚠️ Failed to fetch IANA RDAP ${family.toUpperCase()} bootstrap: ${err.message}`);
      return state.entries; // Return stale cache if any, else []
    } finally {
      state.inflight = null;
    }
  })();

  return state.inflight;
}

function resetBootstrapForTests() {
  for (const family of ["ipv4", "ipv6"]) {
    if (bootstrapState[family].watcher) {
      try {
        bootstrapState[family].watcher.close();
      } catch (_) {}
    }
    bootstrapState[family].entries = [];
    bootstrapState[family].source = null;
    bootstrapState[family].loadedAt = 0;
    bootstrapState[family].watcher = null;
    bootstrapState[family].inflight = null;
  }
  bootstrapInitialized = false;
}

module.exports = {
  IANA_RDAP_URLS,
  getBootstrapPath,
  ipv4ToBigInt,
  ipv6ToBigInt,
  normalizeQueryIp,
  parseCidr,
  normalizeRdapBaseUrl,
  parseBootstrapServices,
  matchBootstrapUrls,
  loadBootstrapFromDisk,
  initWhoisBootstrap,
  ensureBootstrapEntries,
  bootstrapState,
  resetBootstrapForTests,
};
