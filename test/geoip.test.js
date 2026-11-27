const test = require("node:test");
const assert = require("node:assert/strict");

const { getGeoData, mergeLocationData, _internals } = require("../src/geoip");

test.afterEach(() => {
  _internals.setLookupsForTests({});
});

test("cleanValue filters placeholder tokens and IP2Location/IP2Proxy error strings", () => {
  assert.equal(_internals.cleanValue("London"), "London");
  assert.equal(_internals.cleanValue("  UK  "), "UK");
  assert.equal(_internals.cleanValue("-"), null);
  assert.equal(_internals.cleanValue("?"), null);
  assert.equal(_internals.cleanValue("N/A"), null);
  assert.equal(_internals.cleanValue("Unknown"), null);
  assert.equal(_internals.cleanValue("IPV6 ADDRESS MISSING IN IPV4 BIN"), null);
  assert.equal(_internals.cleanValue("INVALID IP ADDRESS"), null);
  assert.equal(_internals.cleanValue("INVALID_IP_ADDRESS"), null);
  assert.equal(_internals.cleanValue("MISSING_FILE"), null);
  assert.equal(_internals.cleanValue("This parameter is unavailable for selected data file."), null);
  assert.equal(_internals.cleanValue(null), null);
});

test("getGeoData detects local, reserved, and Docker bridge ranges accurately", () => {
  for (const localIp of [
    "127.0.0.1",
    "::1",
    "192.168.1.10",
    "10.0.0.5",
    "169.254.1.1",
    "fc00::1",
    "fd00::1234",
    "172.16.0.1",
    "172.31.255.254",
  ]) {
    const res = getGeoData(localIp);
    assert.equal(res.country, "Reserved", `Expected Reserved for ${localIp}`);
    assert.equal(res.city, "Local Network", `Expected Local Network for ${localIp}`);
    assert.equal(res.proxy_type, "Local");
  }

  // 172.15.x.x and 172.32.x.x are public, NOT Docker private space
  assert.notEqual(getGeoData("172.15.0.1").country, "Reserved");
  assert.notEqual(getGeoData("172.32.0.1").country, "Reserved");

  // Non-string input does not throw
  assert.equal(getGeoData(null).country, "Unknown");
});

test("getGeoData classifies VPNs, proxies, hosting providers, and ignores WAP", () => {
  // 1. IP2Proxy VPN detection
  _internals.setLookupsForTests({
    asnLookup: {
      getWithPrefixLength: () => [{ autonomous_system_number: 12345, autonomous_system_organization: "Some Net" }, 24],
    },
    proxyLookup: {
      getAll: () => ({
        isProxy: 1,
        proxyType: "VPN",
        usageType: "DCH",
        provider: "NordVPN",
        threat: "None",
      }),
    },
  });
  const vpnRes = getGeoData("203.0.113.42");
  assert.equal(vpnRes.is_proxy, true);
  assert.equal(vpnRes.proxy_type, "VPN Service");
  assert.equal(vpnRes.usage_type, "Datacenter");
  assert.equal(vpnRes.provider, "NordVPN");
  assert.equal(vpnRes.network, "203.0.113.0/24");

  // 2. WAP (Wireless Access Point) is NOT flagged as proxy risk
  _internals.setLookupsForTests({
    proxyLookup: {
      getAll: () => ({ isProxy: 1, proxyType: "WAP", usageType: "MOB" }),
    },
  });
  const wapRes = getGeoData("198.51.100.10");
  assert.equal(wapRes.is_proxy, false);
  assert.equal(wapRes.usage_type, "Mobile Data");

  // 3. IPinfo hosting classification flags Cloud/VPS Provider
  _internals.setLookupsForTests({
    ipinfoAsnLookup: {
      get: () => ({ asn: "AS14061", name: "DigitalOcean, LLC", type: "hosting" }),
    },
  });
  const hostRes = getGeoData("198.51.100.20");
  assert.equal(hostRes.is_proxy, true);
  assert.equal(hostRes.proxy_type, "Cloud/VPS Provider");
  assert.equal(hostRes.usage_type, "Datacenter");
  assert.equal(hostRes.asn, "AS14061");

  // 4. High-risk VPN ASN match (AS9009 = M247)
  _internals.setLookupsForTests({
    asnLookup: {
      getWithPrefixLength: () => [{ autonomous_system_number: 9009, autonomous_system_organization: "Unlisted Name" }, 24],
    },
  });
  const asnRes = getGeoData("198.51.100.30");
  assert.equal(asnRes.is_proxy, true);
  assert.equal(asnRes.proxy_type, "VPN ASN Match");
  assert.equal(asnRes.threat, "High (VPN Hosting)");
});

test("getGeoData merges MaxMind and DB11 cleanly without mixing cities and keeps compatible IANA timezone", () => {
  // MaxMind has country/timezone but no city; DB11 fills city/region/coords while keeping compatible MaxMind IANA timezone
  _internals.setLookupsForTests({
    cityLookup: {
      get: () => ({
        country: { names: { en: "United Kingdom" }, iso_code: "GB" },
        location: { time_zone: "Europe/London", latitude: 0, longitude: 0 },
      }),
    },
    db11Lookup: {
      getAll: () => ({
        countryLong: "United Kingdom",
        countryShort: "GB",
        region: "England",
        city: "Manchester",
        zipCode: "M1",
        timeZone: "+00:00",
        latitude: "53.4808",
        longitude: "-2.2426",
      }),
    },
  });

  const merged = getGeoData("2001:db8::1");
  assert.equal(merged.city, "Manchester");
  assert.equal(merged.region, "England");
  assert.equal(merged.zip, "M1");
  assert.equal(merged.timezone, "Europe/London");
  assert.equal(merged.latitude, 53.4808);
  assert.equal(merged.longitude, -2.2426);
});

test("does not mix DB11 postcode (TW16) when MaxMind reports a different city (Hackney)", () => {
  const cityData = {
    country: { iso_code: "GB", names: { en: "United Kingdom" } },
    city: { names: { en: "Hackney" } },
    subdivisions: [{ names: { en: "England" } }],
    location: { latitude: 51.545, longitude: -0.0553, time_zone: "Europe/London" },
  };
  const db11Data = {
    countryShort: "GB",
    countryLong: "United Kingdom of Great Britain and Northern Ireland",
    region: "Surrey",
    city: "Sunbury-on-Thames",
    zipCode: "TW16",
    latitude: "51.408330",
    longitude: "-0.416670",
    timeZone: "+00:00",
  };

  const result = mergeLocationData(cityData, db11Data);
  assert.equal(result.city, "Hackney");
  assert.equal(result.region, "England");
  assert.equal(result.country, "United Kingdom");
  assert.equal(result.country_code, "GB");
  assert.equal(result.timezone, "Europe/London");
  assert.equal(result.latitude, 51.545);
  assert.equal(result.longitude, -0.0553);
  assert.equal(result.zip, "N/A");
});

test("uses MaxMind postal code when present even if DB11 disagrees", () => {
  const cityData = {
    country: { iso_code: "GB", names: { en: "United Kingdom" } },
    city: { names: { en: "Hackney" } },
    subdivisions: [{ names: { en: "England" } }],
    postal: { code: "E8" },
    location: { latitude: 51.545, longitude: -0.0553, time_zone: "Europe/London" },
  };
  const db11Data = {
    countryShort: "GB",
    countryLong: "United Kingdom of Great Britain and Northern Ireland",
    region: "Surrey",
    city: "Sunbury-on-Thames",
    zipCode: "TW16",
    latitude: "51.408330",
    longitude: "-0.416670",
    timeZone: "+00:00",
  };

  const result = mergeLocationData(cityData, db11Data);
  assert.equal(result.city, "Hackney");
  assert.equal(result.zip, "E8");
});

test("enriches missing MaxMind postal and region from DB11 when both DBs agree on the city", () => {
  const cityData = {
    country: { iso_code: "BR", names: { en: "Brazil" } },
    city: { names: { en: "São Paulo" } },
    location: { latitude: -23.5475, longitude: -46.6361, time_zone: "America/Sao_Paulo" },
  };
  const db11Data = {
    countryShort: "BR",
    countryLong: "Brazil",
    region: "Sao Paulo",
    city: "Sao Paulo",
    zipCode: "01000-000",
    latitude: "-23.547500",
    longitude: "-46.636100",
    timeZone: "-03:00",
  };

  const result = mergeLocationData(cityData, db11Data);
  assert.equal(result.city, "São Paulo");
  assert.equal(result.region, "Sao Paulo");
  assert.equal(result.zip, "01000-000");
  assert.equal(result.timezone, "America/Sao_Paulo");
});

test("never borrows DB11 region when MaxMind has a city without subdivision and DB11 has a different city", () => {
  const cityData = {
    country: { iso_code: "GB", names: { en: "United Kingdom" } },
    city: { names: { en: "Hackney" } },
    location: { latitude: 51.545, longitude: -0.0553, time_zone: "Europe/London" },
  };
  const db11Data = {
    countryShort: "GB",
    countryLong: "United Kingdom of Great Britain and Northern Ireland",
    region: "Surrey",
    city: "Sunbury-on-Thames",
    zipCode: "TW16",
    latitude: "51.408330",
    longitude: "-0.416670",
    timeZone: "+00:00",
  };

  const result = mergeLocationData(cityData, db11Data);
  assert.equal(result.city, "Hackney");
  assert.equal(result.region, "Unknown");
  assert.equal(result.zip, "N/A");
});

test("uses DB11 offset instead of incompatible MaxMind country-centroid IANA timezone in multi-timezone countries", () => {
  const cityData = {
    country: { iso_code: "US", names: { en: "United States" } },
    location: { latitude: 37.751, longitude: -97.822, time_zone: "America/Chicago" },
  };
  const db11Data = {
    countryShort: "US",
    countryLong: "United States of America",
    region: "California",
    city: "Los Angeles",
    zipCode: "90001",
    latitude: "34.0522",
    longitude: "-118.2437",
    timeZone: "-08:00",
  };

  const result = mergeLocationData(cityData, db11Data);
  assert.equal(result.country, "United States");
  assert.equal(result.city, "Los Angeles");
  assert.equal(result.region, "California");
  assert.equal(result.zip, "90001");
  assert.equal(result.timezone, "-08:00");
});

test("uses DB11 country when MaxMind has no city and countries disagree", () => {
  const cityData = {
    country: { iso_code: "US", names: { en: "United States" } },
    location: { latitude: 37.751, longitude: -97.822, time_zone: "America/Chicago" },
  };
  const db11Data = {
    countryShort: "CA",
    countryLong: "Canada",
    region: "Ontario",
    city: "Toronto",
    zipCode: "M5V",
    latitude: "43.6532",
    longitude: "-79.3832",
    timeZone: "-05:00",
  };

  const result = mergeLocationData(cityData, db11Data);
  assert.equal(result.country, "Canada");
  assert.equal(result.country_code, "CA");
  assert.equal(result.city, "Toronto");
  assert.equal(result.region, "Ontario");
  assert.equal(result.zip, "M5V");
  assert.equal(result.timezone, "-05:00");
});

test("sanitizes DB11 sentinel error values in mergeLocationData", () => {
  const db11Data = {
    countryShort: "MISSING_FILE",
    countryLong: "MISSING_FILE",
    region: "-",
    city: "This parameter is unavailable for selected data file.",
    zipCode: "INVALID_IP_ADDRESS",
    latitude: "0.000000",
    longitude: "0.000000",
    timeZone: "?",
  };

  const result = mergeLocationData(null, db11Data);
  assert.equal(result.country, "Unknown");
  assert.equal(result.country_code, "XX");
  assert.equal(result.city, "Unknown");
  assert.equal(result.region, "Unknown");
  assert.equal(result.timezone, "Unknown");
  assert.equal(result.latitude, 0);
  assert.equal(result.longitude, 0);
  assert.equal(result.zip, "N/A");
});
