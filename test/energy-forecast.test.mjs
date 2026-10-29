import test from "node:test";
import assert from "node:assert/strict";
import {
  emptyEnergyProfile,
  energyProfileHash,
} from "../src/energy-profile.mjs";
import {
  OpenMeteoEnergyForecast,
  energyWeatherConfig,
  parseEnergyWeather,
  combineEnergyWeather,
} from "../src/energy-forecast.mjs";
const tenant = "11111111-1111-4111-8111-111111111111";
function fixture() {
  const profile = emptyEnergyProfile();
  profile.site = {
    latitude: 42.7,
    longitude: 23.3,
    inverterKw: 20,
    arrays: [
      {
        name: "East",
        kwp: 10,
        tilt: 30,
        azimuth: 90,
        lossFraction: 0.14,
        geometryConfirmed: true,
      },
    ],
  };
  return profile;
}
function weather() {
  const start = Date.parse("2026-10-29T00:00Z") / 1000;
  return {
    utc_offset_seconds: 0,
    hourly_units: {
      time: "unixtime",
      global_tilted_irradiance: "W/m²",
      temperature_2m: "°C",
      cloud_cover: "%",
    },
    hourly: {
      time: Array.from({ length: 72 }, (_, index) => start + index * 3600),
      global_tilted_irradiance: Array(72).fill(500),
      temperature_2m: Array(72).fill(10),
      cloud_cover: Array(72).fill(30),
    },
  };
}
const calibration = {
  scale: 1,
  lowScale: 0.75,
  highScale: 1.25,
  days: 0,
  source: "configured-scenarios",
};

test("forecast access is explicit, bound for evaluation and supports commercial server credentials", () => {
  assert.equal(energyWeatherConfig({}).mode, "disabled");
  assert.throws(() =>
    energyWeatherConfig({ ENERGY_WEATHER_MODE: "commercial" }),
  );
  assert.throws(() =>
    energyWeatherConfig({ ENERGY_WEATHER_MODE: "evaluation" }),
  );
  const provider = new OpenMeteoEnergyForecast(
    energyWeatherConfig({
      ENERGY_WEATHER_MODE: "evaluation",
      ENERGY_WEATHER_EVALUATION_TENANT: tenant,
    }),
  );
  assert.equal(provider.available(tenant), true);
  assert.equal(
    provider.available("22222222-2222-4222-8222-222222222222"),
    false,
  );
});

test("radiation preceding-hour alignment is preserved and missing values never become zero solar", () => {
  const data = weather(),
    plane = fixture().site.arrays[0],
    parsed = parseEnergyWeather(data, plane);
  assert.equal(parsed[0].end, data.hourly.time[0] * 1000);
  assert.equal(parsed[0].start, (data.hourly.time[0] - 3600) * 1000);
  assert.ok(parsed[0].rawKw > 0);
  for (const change of [
    (value) => (value.hourly.global_tilted_irradiance[0] = null),
    (value) => (value.hourly.temperature_2m[0] = "10"),
    (value) => (value.hourly.time[1] += 60),
    (value) => (value.hourly_units.global_tilted_irradiance = "kWh"),
    (value) => (value.utc_offset_seconds = 7200),
  ]) {
    const invalid = structuredClone(data);
    change(invalid);
    assert.throws(() => parseEnergyWeather(invalid, plane));
  }
});

test("roof planes are combined without exceeding the inverter rating", () => {
  const profile = fixture();
  profile.site.inverterKw = 5;
  const parsed = parseEnergyWeather(weather(), profile.site.arrays[0]);
  const combined = combineEnergyWeather([parsed, parsed], profile, calibration);
  assert.equal(combined[0].expectedKw, 5);
  assert.ok(combined[0].highKw <= 5);
  const shifted = structuredClone(parsed);
  shifted[0].start += 3600000;
  assert.throws(() =>
    combineEnergyWeather([parsed, shifted], profile, calibration),
  );
});

test("forecast requests use the official host, correct east bearing and bounded response validation", async () => {
  let calls = 0;
  const provider = new OpenMeteoEnergyForecast(
    { mode: "evaluation", evaluationTenant: tenant, apiKey: null },
    async (url, options) => {
      calls++;
      assert.equal(url.origin, "https://api.open-meteo.com");
      assert.equal(url.searchParams.get("azimuth"), "-90");
      assert.equal(url.searchParams.get("tilt"), "30");
      assert.equal(url.searchParams.get("timeformat"), "unixtime");
      assert.equal(url.searchParams.has("apikey"), false);
      assert.equal(options.redirect, "error");
      return Response.json(weather());
    },
  );
  const result = await provider.fetch(fixture(), tenant, calibration);
  assert.equal(calls, 1);
  assert.equal(result.slots.length, 72);
  assert.equal(result.provider, "open-meteo");
  assert.equal(result.accessMode, "evaluation");
  assert.ok(!JSON.stringify(result).includes("apikey"));
  await assert.rejects(
    provider.fetch(
      fixture(),
      "22222222-2222-4222-8222-222222222222",
      calibration,
    ),
    { code: "weather-access-unconfigured" },
  );
  assert.equal(calls, 1);
});

test("provider errors and cancellation do not expose keys or manufacture a forecast", async () => {
  const provider = new OpenMeteoEnergyForecast(
    {
      mode: "commercial",
      evaluationTenant: null,
      apiKey: "fixture-only-weather-secret",
    },
    async (url) => {
      assert.equal(url.origin, "https://customer-api.open-meteo.com");
      assert.equal(
        url.searchParams.get("apikey"),
        "fixture-only-weather-secret",
      );
      return new Response("upstream confidential text", { status: 429 });
    },
  );
  await assert.rejects(
    provider.fetch(fixture(), tenant, calibration),
    (error) =>
      error.code === "weather-rate-limited" &&
      !error.message.includes("confidential") &&
      !error.message.includes("secret"),
  );
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(
    provider.fetch(fixture(), tenant, calibration, aborted.signal),
    { code: "weather-cancelled" },
  );
});

test("profile hashes survive PostgreSQL JSONB key ordering", () => {
  const value = fixture(),
    reordered = Object.fromEntries(Object.entries(value).reverse());
  reordered.battery = Object.fromEntries(
    Object.entries(value.battery).reverse(),
  );
  assert.equal(energyProfileHash(value), energyProfileHash(reordered));
});
