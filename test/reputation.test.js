process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert/strict");
const { BlockList } = require("node:net");
const dns = require("dns").promises;
const axios = require("axios");

const getReputation = require("../src/reputation");
const { setBlockListForTests, resetForTests } = getReputation._internals;

const ENV_KEYS = [
  "CROWDSEC_API_KEY",
  "ABUSEIPDB_API_KEY",
  "SNIFFCAT_API_KEY",
  "SPAMVERIFY_API_KEY",
];

let savedEnv = {};

test.beforeEach(() => {
  resetForTests();
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

test.afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  resetForTests();
});

test("getReputation validates IPs and matches IPv4/IPv6 CIDR rules in memory blocklist", async () => {
  assert.deepEqual(await getReputation("not-an-ip"), {
    ip: "not-an-ip",
    error: "Invalid IP",
  });
  assert.deepEqual(await getReputation(null), {
    ip: "",
    error: "Invalid IP",
  });

  const list = new BlockList();
  list.addSubnet("203.0.113.0", 24, "ipv4");
  list.addSubnet("2001:db8:bad::", 48, "ipv6");
  setBlockListForTests(list);

  const origResolve4 = dns.resolve4;
  let dnsblCalls = 0;
  dns.resolve4 = async () => {
    dnsblCalls++;
    throw new Error("ENOTFOUND");
  };

  try {
    // IPv6 skips DNSBL entirely and matches IPv6 CIDR blocklist
    const v6Hit = await getReputation("2001:db8:bad::99");
    assert.equal(dnsblCalls, 0);
    assert.equal(v6Hit.is_clean, false);
    assert.equal(v6Hit.detections.length, 1);
    assert.equal(v6Hit.detections[0].source, "Threat Feed");

    // IPv4 matches CIDR blocklist
    const v4Hit = await getReputation("203.0.113.55");
    assert.equal(v4Hit.is_clean, false);
    assert.ok(v4Hit.detections.some((d) => d.source === "Threat Feed"));

    // Unlisted IPv6 returns clean
    const clean = await getReputation("2001:db8:cafe::1");
    assert.equal(clean.is_clean, true);
    assert.deepEqual(clean.detections, []);
  } finally {
    dns.resolve4 = origResolve4;
  }
});

test("getReputation aggregates external threat APIs, caches results, and trips 429 circuit breakers", async () => {
  process.env.CROWDSEC_API_KEY = "cs-key";
  process.env.ABUSEIPDB_API_KEY = "abuse-key";

  const origGet = axios.get;
  let abuseCalls = 0;
  let crowdsecCalls = 0;

  axios.get = async (url) => {
    if (url.includes("/v1/decisions")) {
      crowdsecCalls++;
      return { data: [{ scenario: "crowdsecurity/http-probing" }] };
    }
    if (url.includes("api.abuseipdb.com")) {
      abuseCalls++;
      if (abuseCalls === 1) {
        return { data: { data: { abuseConfidenceScore: 85, totalReports: 12 } } };
      }
      const err = new Error("Rate limited");
      err.response = { status: 429 };
      throw err;
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  try {
    // 1. Aggregates CrowdSec + AbuseIPDB for IPv6
    const first = await getReputation("2001:db8::10");
    assert.equal(first.is_clean, false);
    assert.deepEqual(
      first.detections.map((d) => d.source).sort(),
      ["AbuseIPDB", "CrowdSec"],
    );

    // 2. Cached result avoids repeating API calls
    const cached = await getReputation("2001:db8::10");
    assert.equal(crowdsecCalls, 1);
    assert.equal(abuseCalls, 1);
    assert.equal(cached.detections.length, 2);

    // 3. 429 from AbuseIPDB trips circuit breaker so next uncached IP skips AbuseIPDB
    await getReputation("2001:db8::20");
    assert.equal(abuseCalls, 2);
    await getReputation("2001:db8::30");
    assert.equal(abuseCalls, 2); // Still 2 because breaker paused AbuseIPDB
  } finally {
    axios.get = origGet;
  }
});
