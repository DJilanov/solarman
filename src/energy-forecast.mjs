import { createHash } from "node:crypto";
import {
  missingEnergyInputs,
  validateEnergyProfile,
} from "./energy-profile.mjs";

export class EnergyForecastError extends Error {
  /** @param {string} code */
  constructor(code) {
    super(
      "Solar forecast is unavailable; the last plan has not been replaced with zero production",
    );
    this.code = code;
  }
}

/** @param {Record<string,string|undefined>} env @returns {{mode:'disabled'|'evaluation'|'commercial',apiKey:string|null,evaluationTenant:string|null}} */
export function energyWeatherConfig(env) {
  const mode = env.ENERGY_WEATHER_MODE ?? "disabled";
  if (!["disabled", "evaluation", "commercial"].includes(mode))
    throw new Error("Choose a valid energy weather access mode");
  const apiKey = env.OPEN_METEO_API_KEY?.trim() || null,
    evaluationTenant = env.ENERGY_WEATHER_EVALUATION_TENANT?.trim() || null;
  if (mode === "commercial" && (!apiKey || apiKey.length > 256))
    throw new Error("Commercial weather access requires its API key");
  if (
    mode === "evaluation" &&
    (!evaluationTenant ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
        evaluationTenant,
      ))
  )
    throw new Error("Weather evaluation must be bound to one workspace");
  return { mode, apiKey, evaluationTenant };
}

/** @param {unknown} value @param {number} min @param {number} max @returns {value is number} */
function numeric(value, min, max) {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= min &&
    value <= max
  );
}

/** @param {unknown} data @param {object} plane @returns {object[]} */
export function parseEnergyWeather(data, plane) {
  if (
    !data ||
    typeof data !== "object" ||
    !data.hourly ||
    typeof data.hourly !== "object" ||
    data.utc_offset_seconds !== 0
  )
    throw new EnergyForecastError("weather-invalid");
  const {
    time,
    global_tilted_irradiance: radiation,
    temperature_2m: temperature,
    cloud_cover: cloud,
  } = data.hourly;
  if (
    !Array.isArray(time) ||
    time.length < 24 ||
    time.length > 192 ||
    ![radiation, temperature, cloud].every(
      (values) => Array.isArray(values) && values.length === time.length,
    )
  )
    throw new EnergyForecastError("weather-invalid");
  if (
    !["W/m²", "W/m2"].includes(data.hourly_units?.global_tilted_irradiance) ||
    data.hourly_units?.temperature_2m !== "°C" ||
    data.hourly_units?.cloud_cover !== "%" ||
    data.hourly_units?.time !== "unixtime"
  )
    throw new EnergyForecastError("weather-units");
  const slots = [];
  for (let index = 0; index < time.length; index++) {
    if (
      !Number.isInteger(time[index]) ||
      time[index] <= 0 ||
      (index > 0 && time[index] - time[index - 1] !== 3600)
    )
      throw new EnergyForecastError("weather-timeline");
    const irradiance = radiation[index],
      ambient = temperature[index],
      cloudCover = cloud[index];
    if (
      !numeric(irradiance, 0, 2000) ||
      !numeric(ambient, -80, 65) ||
      !numeric(cloudCover, 0, 100)
    )
      throw new EnergyForecastError("weather-missing-values");
    const cellTemperature = ambient + irradiance * 0.03,
      temperatureFactor = Math.min(
        1.2,
        Math.max(0.5, 1 - 0.004 * (cellTemperature - 25)),
      );
    const rawKw = Math.max(
      0,
      plane.kwp *
        (irradiance / 1000) *
        (1 - plane.lossFraction) *
        temperatureFactor,
    );
    // Open-Meteo radiation values cover the preceding hour, not the hour starting at the timestamp.
    slots.push({
      start: (time[index] - 3600) * 1000,
      end: time[index] * 1000,
      rawKw,
      irradiance,
      temperatureC: ambient,
      cloudCover,
    });
  }
  return slots;
}

/** @param {object[][]} planes @param {object} profile @param {object} calibration @returns {object[]} */
export function combineEnergyWeather(planes, profile, calibration) {
  if (!planes.length) throw new EnergyForecastError("weather-no-panels");
  const result = planes[0].map((slot, index) => {
    if (
      planes.some(
        (plane) =>
          plane[index]?.start !== slot.start || plane[index]?.end !== slot.end,
      )
    )
      throw new EnergyForecastError("weather-timeline");
    const rawKw = planes.reduce((sum, plane) => sum + plane[index].rawKw, 0);
    return {
      start: slot.start,
      end: slot.end,
      rawKw: Math.min(profile.site.inverterKw, rawKw),
      expectedKw: Math.min(profile.site.inverterKw, rawKw * calibration.scale),
      lowKw: Math.min(profile.site.inverterKw, rawKw * calibration.lowScale),
      highKw: Math.min(profile.site.inverterKw, rawKw * calibration.highScale),
      temperatureC: slot.temperatureC,
      cloudCover: slot.cloudCover,
    };
  });
  return result;
}

/** @param {Response} response @returns {Promise<unknown>} */
async function boundedWeatherJson(response) {
  if (!response.ok)
    throw new EnergyForecastError(
      response.status === 429
        ? "weather-rate-limited"
        : "weather-provider-error",
    );
  if (
    Number(response.headers.get("content-length") ?? 0) > 256 * 1024 ||
    !response.body
  )
    throw new EnergyForecastError("weather-response-size");
  const reader = response.body.getReader(),
    chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 256 * 1024)
        throw new EnergyForecastError("weather-response-size");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new EnergyForecastError("weather-invalid-json");
  }
}

export class OpenMeteoEnergyForecast {
  /** @param {ReturnType<typeof energyWeatherConfig>} config @param {typeof fetch} [transport] */
  constructor(config, transport = globalThis.fetch) {
    this.config = config;
    this.transport = transport;
    this.pending = Promise.resolve();
    this.lastAt = 0;
  }
  /** @param {string} tenantId @returns {boolean} */
  available(tenantId) {
    return (
      this.config.mode === "commercial" ||
      (this.config.mode === "evaluation" &&
        tenantId === this.config.evaluationTenant)
    );
  }
  /** @param {object} profile @param {string} tenantId @param {object} calibration @param {AbortSignal} [signal] @returns {Promise<object>} */
  async fetch(profile, tenantId, calibration, signal) {
    validateEnergyProfile(profile);
    if (!this.available(tenantId))
      throw new EnergyForecastError("weather-access-unconfigured");
    if (
      missingEnergyInputs(profile).some((key) =>
        ["location", "panels", "inverter"].includes(key),
      )
    )
      throw new EnergyForecastError("weather-site-incomplete");
    const planes = [];
    for (const plane of profile.site.arrays) {
      const prior = this.pending;
      let release;
      this.pending = new Promise((resolve) => {
        release = resolve;
      });
      await prior;
      try {
        if (signal?.aborted) throw new EnergyForecastError("weather-cancelled");
        const delay = Math.max(0, 500 - (Date.now() - this.lastAt));
        if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
        this.lastAt = Date.now();
        const url = new URL(
          this.config.mode === "commercial"
            ? "https://customer-api.open-meteo.com/v1/forecast"
            : "https://api.open-meteo.com/v1/forecast",
        );
        for (const [key, value] of Object.entries({
          latitude: profile.site.latitude,
          longitude: profile.site.longitude,
          hourly: "global_tilted_irradiance,temperature_2m,cloud_cover",
          tilt: plane.tilt,
          azimuth: plane.azimuth - 180,
          timezone: "GMT",
          timeformat: "unixtime",
          forecast_days: 4,
          past_days: 1,
        }))
          url.searchParams.set(key, String(value));
        if (this.config.mode === "commercial")
          url.searchParams.set("apikey", this.config.apiKey);
        const response = await this.transport(url, {
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(12000)])
            : AbortSignal.timeout(12000),
          redirect: "error",
          headers: { accept: "application/json" },
        });
        planes.push(
          parseEnergyWeather(await boundedWeatherJson(response), plane),
        );
      } catch (error) {
        if (error instanceof EnergyForecastError) throw error;
        throw new EnergyForecastError(
          signal?.aborted ? "weather-cancelled" : "weather-unreachable",
        );
      } finally {
        release();
      }
    }
    const slots = combineEnergyWeather(planes, profile, calibration),
      fetchedAt = new Date().toISOString();
    return {
      provider: "open-meteo",
      sourceUrl: "https://open-meteo.com/",
      accessMode: this.config.mode,
      attribution:
        "Weather data by Open-Meteo; PV output modelled by this application",
      fetchedAt,
      expiresAt: new Date(Date.now() + 3 * 3600000).toISOString(),
      slots,
      calibration,
      modelAssumptions: {
        temperatureCoefficientPerC: -0.004,
        cellTemperatureRisePerWm2: 0.03,
      },
      hash: createHash("sha256")
        .update(JSON.stringify({ slots, calibration }))
        .digest("hex"),
    };
  }
}
