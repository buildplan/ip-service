const test = require("node:test");
const assert = require("node:assert/strict");
const { mergeLocationData, getGeoData } = require("../src/geoip");

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

test("falls back cleanly to DB11 when MaxMind lacks city", () => {
  const cityData = {
    country: { iso_code: "GB", names: { en: "United Kingdom" } },
    location: { latitude: 51.4964, longitude: -0.1224, time_zone: "Europe/London" },
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
  assert.equal(result.country, "United Kingdom");
  assert.equal(result.country_code, "GB");
  assert.equal(result.city, "Sunbury-on-Thames");
  assert.equal(result.region, "Surrey");
  assert.equal(result.zip, "TW16");
  assert.equal(result.latitude, 51.40833);
  assert.equal(result.longitude, -0.41667);
  assert.equal(result.timezone, "+00:00");
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

test("sanitizes DB11 sentinel error values", () => {
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

test("handles reserved IP cleanly in getGeoData", () => {
  const res = getGeoData("127.0.0.1");
  assert.equal(res.country, "Reserved");
  assert.equal(res.city, "Local Network");
});
