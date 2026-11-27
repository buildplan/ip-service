const axios = require("axios");
const { LRUCache } = require("lru-cache");

const bootstrap = require("./bootstrap");
const parser = require("./parser");

const appUrl = process.env.APP_URL || "https://github.com/buildplan/ip-service";
const adminEmail = process.env.ADMIN_EMAIL || "open-source-user@example.com";
const customUserAgent = `Threat-Intel-API/1.0 (${appUrl}; ${adminEmail})`;

const CIRCUIT_BREAKER_MS = 60 * 60 * 1000; // 1 hour per-host pause on 429

const ALLOWED_RDAP_HOSTS = new Set([
  "rdap.arin.net",
  "rdap.db.ripe.net",
  "rdap.apnic.net",
  "rdap.lacnic.net",
  "rdap.afrinic.net",
  "rdap.registro.br",
  "rdap.org",
]);

function toSafeHttpsUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return null;
    if (parsed.username || parsed.password) return null;
    const host = parsed.hostname.toLowerCase();
    if (!ALLOWED_RDAP_HOSTS.has(host)) return null;
    return parsed;
  } catch (_) {
    return null;
  }
}

function buildRdapIpUrl(baseUrl, queryIp) {
  const parsedBase = toSafeHttpsUrl(baseUrl);
  if (!parsedBase) return null;
  if (
    typeof queryIp !== "string" ||
    (!/^[0-9.]+$/.test(queryIp) && !/^[0-9a-f:]+$/.test(queryIp))
  ) {
    return null;
  }
  parsedBase.pathname = `${parsedBase.pathname.replace(/\/?$/, "/")}ip/${queryIp}`;
  parsedBase.search = "";
  parsedBase.hash = "";
  return parsedBase.toString();
}

// Bounded LRU cache to keep memory low on small servers (~<1MB max)
const whoisCache = new LRUCache({
  max: 500,
  ttl: 6 * 60 * 60 * 1000, // 6 hours
});

// Per-host circuit breakers: host -> reset timestamp (ms)
const hostCircuitBreakers = new Map();

function getUrlHost(url) {
  try {
    return new URL(url).host.toLowerCase();
  } catch (_) {
    return url;
  }
}

function isHostBlocked(host) {
  const resetTime = hostCircuitBreakers.get(host);
  if (!resetTime) return false;
  if (Date.now() > resetTime) {
    hostCircuitBreakers.delete(host);
    console.log(`🟢 Circuit Breaker Reset for ${host} - Trying again.`);
    return false;
  }
  return true;
}

function tripHostBreaker(host) {
  console.warn(`⚠️ Rate limit (429) on ${host}. Pausing queries to this host for 1 hour.`);
  hostCircuitBreakers.set(host, Date.now() + CIRCUIT_BREAKER_MS);
}

async function queryRdapUrl(url, displayIp) {
  const safeUrl = toSafeHttpsUrl(url);
  if (!safeUrl) {
    return { status: "error" };
  }
  const safeUrlString = safeUrl.toString();
  const host = getUrlHost(safeUrlString);
  if (isHostBlocked(host)) {
    return { status: "rate_limited" };
  }

  try {
    const res = await axios.get(safeUrlString, {
      timeout: 10000,
      headers: {
        Accept: "application/rdap+json, application/json",
        "User-Agent": customUserAgent,
      },
    });
    const parsed = parser.parseRdapResponse(res.data, displayIp);
    if (!parser.isBrokenRdapResult(parsed)) {
      return { status: "ok", data: parsed };
    }
    console.warn(`RDAP (${host}) returned unusable data for ${displayIp}, trying next source...`);
    return { status: "broken" };
  } catch (err) {
    if (err.response && err.response.status === 429) {
      tripHostBreaker(host);
      return { status: "rate_limited" };
    }
    console.warn(
      `RDAP (${host}) failed for ${displayIp} (${err.response?.status || err.code || err.message}), trying next source...`,
    );
    return { status: "error" };
  }
}

async function queryRipeStatFallback(queryIp, displayIp) {
  const ripeHost = "stat.ripe.net";
  if (isHostBlocked(ripeHost)) {
    return {
      error: "WHOIS services temporarily unavailable due to rate limits.",
    };
  }

  try {
    const statRes = await axios.get("https://stat.ripe.net/data/whois/data.json", {
      params: { resource: queryIp },
      timeout: 10000,
      headers: {
        Accept: "application/json",
        "User-Agent": customUserAgent,
      },
    });

    const statData = statRes.data?.data;
    let rawText = "";

    const appendRecordGroups = (groups) => {
      if (!Array.isArray(groups)) return;
      for (const record of groups) {
        if (!Array.isArray(record)) continue;
        for (const entry of record) {
          if (entry && entry.key !== undefined && entry.value !== undefined) {
            rawText += `${entry.key}: ${entry.value}\n`;
          }
        }
        rawText += "\n";
      }
    };

    appendRecordGroups(statData?.records);
    if (!rawText.trim()) {
      appendRecordGroups(statData?.irr_records);
    }

    const hasRecords = Boolean(rawText.trim());
    return {
      ip: displayIp,
      is_raw: true,
      raw_whois: hasRecords ? rawText.trim() : "No WHOIS records found for this IP.",
      _cacheable: hasRecords,
    };
  } catch (fallbackErr) {
    if (fallbackErr.response && fallbackErr.response.status === 429) {
      tripHostBreaker(ripeHost);
      return {
        error: "WHOIS services temporarily unavailable due to rate limits.",
      };
    }
    console.error("WHOIS Fallback Error:", fallbackErr.message);
    return { error: "Registry lookup failed entirely." };
  }
}

async function getWhois(rawIp) {
  const normalized = bootstrap.normalizeQueryIp(rawIp);
  if (!normalized) return { error: "Invalid IP" };

  const { ip: queryIp, version } = normalized;
  const displayIp = rawIp.trim();
  const cacheKey = queryIp.toLowerCase();

  // 1. Check LRU cache
  const cached = whoisCache.get(cacheKey);
  if (cached) {
    return { ...cached, ip: displayIp };
  }

  // 2. Build ordered HTTPS RDAP candidate URLs (unencoded literal IPv6 colons per RFC 9082)
  const family = version === 6 ? "ipv6" : "ipv4";
  const entries = await bootstrap.ensureBootstrapEntries(family, customUserAgent);
  const bootstrapBaseUrls = bootstrap.matchBootstrapUrls(queryIp, version, entries);

  const rdapCandidates = [];
  for (const baseUrl of bootstrapBaseUrls) {
    const candidate = buildRdapIpUrl(baseUrl, queryIp);
    if (candidate && !rdapCandidates.includes(candidate)) {
      rdapCandidates.push(candidate);
    }
  }
  const rdapOrgUrl = buildRdapIpUrl("https://rdap.org/", queryIp);
  if (rdapOrgUrl && !rdapCandidates.includes(rdapOrgUrl)) {
    rdapCandidates.push(rdapOrgUrl);
  }

  // 3. Try direct authoritative RIR RDAP first, then rdap.org fallback
  let sawRateLimit = false;
  for (const url of rdapCandidates) {
    const attempt = await queryRdapUrl(url, displayIp);
    if (attempt.status === "ok") {
      whoisCache.set(cacheKey, attempt.data);
      return attempt.data;
    }
    if (attempt.status === "rate_limited") {
      sawRateLimit = true;
    }
  }

  // 4. Final HTTPS fallback: RIPEstat raw WHOIS
  const fallbackResult = await queryRipeStatFallback(queryIp, displayIp);
  if (fallbackResult.error) {
    if (sawRateLimit && fallbackResult.error === "Registry lookup failed entirely.") {
      return {
        error: "WHOIS services temporarily unavailable due to rate limits.",
      };
    }
    return fallbackResult;
  }

  const { _cacheable, ...cleanFallback } = fallbackResult;
  if (_cacheable) {
    whoisCache.set(cacheKey, cleanFallback);
  }
  return cleanFallback;
}

getWhois.initWhoisBootstrap = bootstrap.initWhoisBootstrap;
getWhois._internals = {
  ...bootstrap,
  ...parser,
  ALLOWED_RDAP_HOSTS,
  toSafeHttpsUrl,
  buildRdapIpUrl,
  whoisCache,
  hostCircuitBreakers,
  isHostBlocked,
  tripHostBreaker,
  resetForTests: () => {
    whoisCache.clear();
    hostCircuitBreakers.clear();
    bootstrap.resetBootstrapForTests();
  },
};

module.exports = getWhois;
