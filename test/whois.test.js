const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const axios = require("axios");

const getWhois = require("../src/whois");
const {
  getBootstrapPath,
  normalizeQueryIp,
  parseBootstrapServices,
  matchBootstrapUrls,
  parseRdapResponse,
  isBrokenRdapResult,
  toSafeHttpsUrl,
  buildRdapIpUrl,
  hostCircuitBreakers,
  resetForTests,
} = getWhois._internals;

const SAMPLE_IPV6_BOOTSTRAP = {
  version: "1.0",
  services: [
    [["2001:4800::/23"], ["https://rdap.arin.net/registry/"]],
    [["2a00::/12"], ["https://rdap.db.ripe.net/"]],
    [["2400::/12"], ["http://rdap.apnic.net/", "https://rdap.apnic.net/"]],
    [["2001:4860::/32"], ["https://rdap-specific.example.net/"]],
  ],
};

test.beforeEach(() => {
  resetForTests();
  delete process.env.RDAP_IPV4_DB_PATH;
  delete process.env.RDAP_IPV6_DB_PATH;
});

test("bootstrap resolves db paths, normalizes IPv4-mapped IPv6, and matches longest HTTPS prefix", () => {
  const repoRoot = path.resolve(__dirname, "..");
  assert.equal(getBootstrapPath("ipv6"), path.join(repoRoot, "db", "rdap-ipv6.json"));
  assert.deepEqual(normalizeQueryIp("::ffff:8.8.8.8"), { ip: "8.8.8.8", version: 4 });
  assert.equal(normalizeQueryIp("invalid"), null);

  const entries = parseBootstrapServices(SAMPLE_IPV6_BOOTSTRAP, true);
  assert.deepEqual(matchBootstrapUrls("2001:4860:4860::8888", 6, entries), [
    "https://rdap-specific.example.net/",
  ]);
  assert.deepEqual(matchBootstrapUrls("2400:cb00::1", 6, entries), [
    "https://rdap.apnic.net/",
  ]);
});

test("RDAP parser handles nested entities, org vCards, remarks, cidr0_cidrs, and empty abuse contacts", () => {
  const payload = {
    handle: "2a00:1450:4000::/37",
    country: "IE",
    cidr0_cidrs: [{ v6prefix: "2a00:1450:4000::", length: 37 }],
    events: [{ eventAction: "registration", eventDate: "2012-03-14T10:20:30Z" }],
    entities: [
      {
        roles: ["registrant"],
        vcardArray: ["vcard", [["org", {}, "text", ["Google Ireland Limited"]]]],
        entities: [
          {
            roles: ["abuse"],
            vcardArray: ["vcard", [["email", {}, "text", "network-abuse@google.com"]]],
          },
        ],
      },
    ],
  };

  const parsed = parseRdapResponse(payload, "2a00:1450:4009::200e");
  assert.equal(parsed.network_range, "2a00:1450:4000::/37");
  assert.equal(parsed.organization, "Google Ireland Limited");
  assert.deepEqual(parsed.abuse_contacts, ["network-abuse@google.com"]);
  assert.equal(isBrokenRdapResult(parsed), false);

  // Valid IPv6 record without abuse contact is kept; IANA / ::/0 placeholders are rejected
  const noAbuse = parseRdapResponse(
    { name: "ISP-V6", handle: "NET6-1", startAddress: "2600:1000::", endAddress: "2600:1000:ffff::" },
    "2600:1000::1",
  );
  assert.equal(isBrokenRdapResult(noAbuse), false);
  assert.equal(isBrokenRdapResult(parseRdapResponse({ name: "IANA-BLOCK" }, "2001:db8::1")), true);
  assert.equal(
    isBrokenRdapResult(parseRdapResponse({ cidr0_cidrs: [{ v6prefix: "::", length: 0 }] }, "2001:db8::1")),
    true,
  );
});

test("getWhois sends unencoded IPv6 RDAP URLs, caches hits, isolates 429 breakers, and falls back to RIPEstat", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ip-service-rdap-"));
  const v6Path = path.join(tmpDir, "rdap-ipv6.json");
  fs.writeFileSync(
    v6Path,
    JSON.stringify({
      version: "1.0",
      services: [
        [["2001:4800::/23"], ["https://rdap.arin.net/registry/"]],
        [["2a00::/12"], ["https://rdap.db.ripe.net/"]],
      ],
    }),
  );
  process.env.RDAP_IPV6_DB_PATH = v6Path;

  const originalGet = axios.get;
  const calls = [];

  axios.get = async (url, config) => {
    calls.push({ url, params: config?.params });
    if (url === "https://rdap.arin.net/registry/ip/2001:4860:4860::8888") {
      return {
        data: {
          name: "GOOGLE-IPV6",
          handle: "NET6-2001-4860-1",
          startAddress: "2001:4860::",
          endAddress: "2001:4860:ffff::",
        },
      };
    }
    if (url.startsWith("https://rdap.arin.net/")) {
      const err = new Error("Too Many Requests");
      err.response = { status: 429 };
      throw err;
    }
    if (url.startsWith("https://rdap.org/")) {
      const err = new Error("Not Found");
      err.response = { status: 404 };
      throw err;
    }
    if (url.startsWith("https://rdap.db.ripe.net/")) {
      return {
        data: {
          name: "RIPE-V6",
          handle: "2a00:1450::/32",
          startAddress: "2a00:1450::",
          endAddress: "2a00:1450:ffff::",
        },
      };
    }
    if (url === "https://stat.ripe.net/data/whois/data.json") {
      return {
        data: {
          data: {
            records: [[{ key: "inet6num", value: "2001:4860::/32" }]],
          },
        },
      };
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  try {
    // 1. Literal colons (no %3A) + cache hit on second call
    const res1 = await getWhois("2001:4860:4860::8888");
    const res1Cached = await getWhois("2001:4860:4860::8888");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://rdap.arin.net/registry/ip/2001:4860:4860::8888");
    assert.equal(res1.network_name, "GOOGLE-IPV6");
    assert.equal(res1Cached.network_name, "GOOGLE-IPV6");

    // 2. ARIN 429 -> rdap.org 404 -> RIPEstat fallback; RIPE host stays unblocked
    const fb = await getWhois("2001:4860:4860::8844");
    assert.equal(fb.is_raw, true);
    assert.match(fb.raw_whois, /inet6num: 2001:4860::\/32/);
    assert.ok(hostCircuitBreakers.has("rdap.arin.net"));

    const ripe = await getWhois("2a00:1450:4009::200e");
    assert.equal(ripe.is_raw, false);
    assert.equal(ripe.network_name, "RIPE-V6");
  } finally {
    axios.get = originalGet;
    resetForTests();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("canonicalizes IPv6 per RFC 5952 and enforces HTTPS RDAP host allowlist", () => {
  assert.deepEqual(normalizeQueryIp("2001:4860:4860:0000:0000:0000:0000:8888"), {
    ip: "2001:4860:4860::8888",
    version: 6,
  });
  assert.deepEqual(normalizeQueryIp("2001:0db8:0000:0001:0000:0000:0000:0001"), {
    ip: "2001:db8:0:1::1",
    version: 6,
  });
  assert.deepEqual(normalizeQueryIp("::1"), { ip: "::1", version: 6 });
  assert.deepEqual(normalizeQueryIp("::"), { ip: "::", version: 6 });

  assert.equal(toSafeHttpsUrl("https://evil.example.com/"), null);
  assert.equal(toSafeHttpsUrl("http://rdap.arin.net/registry/"), null);
  assert.equal(toSafeHttpsUrl("https://user:pass@rdap.arin.net/registry/"), null);

  assert.equal(
    buildRdapIpUrl("https://rdap.arin.net/registry/", "2001:4860:4860::8888"),
    "https://rdap.arin.net/registry/ip/2001:4860:4860::8888",
  );
  assert.equal(buildRdapIpUrl("https://evil.example.com/", "8.8.8.8"), null);
  assert.equal(buildRdapIpUrl("https://rdap.arin.net/registry/", "8.8.8.8?evil=1"), null);
});
