import { createHash } from "node:crypto";
import { energyMinute } from "./energy-time.mjs";

export const ENERGY_MODEL_VERSION = "hourly-pv/load/tariff-battery/v1";
export const BULGARIAN_NIGHT_WINDOWS = Object.freeze([
  { months: [1, 2, 3, 11, 12], startMinute: 22 * 60, endMinute: 6 * 60 },
  { months: [4, 5, 6, 7, 8, 9, 10], startMinute: 23 * 60, endMinute: 7 * 60 },
]);

/** @param {unknown} value @returns {value is Record<string,unknown>} */
function record(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
/** @param {unknown} value @param {number} min @param {number} max @param {string} message @returns {number} */
function number(value, min, max, message) {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < min ||
    value > max
  )
    throw new Error(message);
  return value;
}
/** @param {Record<string,unknown>} value @param {string[]} keys @returns {void} */
function keys(value, keys) {
  if (Object.keys(value).some((key) => !keys.includes(key)))
    throw new Error("Unknown energy-profile setting");
}
/** @param {unknown} value @param {number} max @param {string} message @returns {string} */
function label(value, max, message) {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new Error(message);
  return value.trim();
}

/** @param {string} [timezone] @returns {object} */
export function emptyEnergyProfile(timezone = "Europe/Sofia") {
  return {
    version: 1,
    timezone,
    site: { latitude: null, longitude: null, inverterKw: null, arrays: [] },
    battery: {
      capacityKwh: null,
      reserveSoc: 50,
      backupFloorSoc: 10,
      gridChargeKw: 2,
      pvChargeKw: 2,
      dischargeKw: 2,
      chargeEfficiency: 0.95,
      dischargeEfficiency: 0.95,
      powerConfirmed: false,
      essentialLoadW: null,
    },
    tariff: {
      currency: "EUR",
      dayPrice: null,
      nightPrice: null,
      exportPrice: 0,
      cyclingCost: null,
      windows: structuredClone(BULGARIAN_NIGHT_WINDOWS),
    },
    planning: {
      maximumSoc: 100,
      solarMargin: 0.25,
      loadMargin: 0.2,
      fallbackDailyKwh: null,
      heatingKwPerDegree: 0,
      heatingBaseC: 18,
    },
    loads: [],
  };
}

/** @param {unknown} input @returns {object} */
export function validateEnergyProfile(input) {
  if (!record(input)) throw new Error("Enter valid energy settings");
  keys(input, [
    "version",
    "timezone",
    "site",
    "battery",
    "tariff",
    "planning",
    "loads",
  ]);
  if (
    input.version !== 1 ||
    typeof input.timezone !== "string" ||
    input.timezone.length > 100
  )
    throw new Error("Choose a valid energy-profile version and timezone");
  try {
    new Intl.DateTimeFormat("en", { timeZone: input.timezone }).format();
  } catch {
    throw new Error("Choose a valid IANA timezone");
  }
  const { site, battery, tariff, planning, loads } = input;
  if (![site, battery, tariff, planning].every(record) || !Array.isArray(loads))
    throw new Error("Enter valid installation, battery and tariff settings");
  keys(site, ["latitude", "longitude", "inverterKw", "arrays"]);
  for (const [key, min, max] of [
    ["latitude", -90, 90],
    ["longitude", -180, 180],
    ["inverterKw", 0.1, 10000],
  ])
    if (site[key] !== null)
      number(site[key], min, max, "Enter a valid location and inverter power");
  if (!Array.isArray(site.arrays) || site.arrays.length > 8)
    throw new Error("Configure up to eight roof sections");
  const names = new Set();
  for (const plane of site.arrays) {
    if (!record(plane)) throw new Error("Enter a valid roof section");
    keys(plane, [
      "name",
      "kwp",
      "tilt",
      "azimuth",
      "lossFraction",
      "geometryConfirmed",
    ]);
    const name = label(plane.name, 80, "Name each roof section");
    if (names.has(name)) throw new Error("Roof-section names must be unique");
    names.add(name);
    number(plane.kwp, 0.01, 10000, "Enter panel capacity in kWp");
    number(plane.tilt, 0, 90, "Enter panel tilt between 0 and 90 degrees");
    number(
      plane.azimuth,
      0,
      359.999,
      "Enter panel direction between 0 and 359 degrees",
    );
    number(
      plane.lossFraction,
      0,
      0.5,
      "Enter system losses between 0% and 50%",
    );
    if (typeof plane.geometryConfirmed !== "boolean")
      throw new Error("Confirm whether the roof geometry is known");
  }
  keys(battery, [
    "capacityKwh",
    "reserveSoc",
    "backupFloorSoc",
    "gridChargeKw",
    "pvChargeKw",
    "dischargeKw",
    "chargeEfficiency",
    "dischargeEfficiency",
    "powerConfirmed",
    "essentialLoadW",
  ]);
  if (battery.capacityKwh !== null)
    number(battery.capacityKwh, 0.1, 10000, "Enter battery capacity in kWh");
  number(battery.reserveSoc, 0, 95, "Enter a valid operating reserve");
  number(
    battery.backupFloorSoc,
    0,
    battery.reserveSoc,
    "Backup floor cannot exceed the operating reserve",
  );
  for (const key of ["gridChargeKw", "pvChargeKw", "dischargeKw"])
    number(
      battery[key],
      0.1,
      1000,
      "Enter positive battery planning power limits",
    );
  for (const key of ["chargeEfficiency", "dischargeEfficiency"])
    number(
      battery[key],
      0.5,
      1,
      "Enter battery efficiencies between 50% and 100%",
    );
  if (typeof battery.powerConfirmed !== "boolean")
    throw new Error("Confirm whether the battery power limits are known");
  if (battery.essentialLoadW !== null)
    number(
      battery.essentialLoadW,
      50,
      100000,
      "Enter essential-load power in watts",
    );
  keys(tariff, [
    "currency",
    "dayPrice",
    "nightPrice",
    "exportPrice",
    "cyclingCost",
    "windows",
  ]);
  if (
    typeof tariff.currency !== "string" ||
    !/^[A-Z]{3}$/.test(tariff.currency) ||
    !Intl.supportedValuesOf("currency").includes(tariff.currency)
  )
    throw new Error("Choose a valid billing currency");
  for (const key of ["dayPrice", "nightPrice"])
    if (tariff[key] !== null)
      number(
        tariff[key],
        0,
        100,
        "Enter non-negative electricity prices per kWh",
      );
  number(tariff.exportPrice, 0, 100, "Enter a non-negative export payment");
  if (tariff.cyclingCost !== null)
    number(
      tariff.cyclingCost,
      0,
      100,
      "Enter a non-negative battery cycling allowance",
    );
  if (!Array.isArray(tariff.windows) || tariff.windows.length > 12)
    throw new Error("Enter valid seasonal tariff windows");
  const months = new Set();
  for (const window of tariff.windows) {
    if (!record(window)) throw new Error("Enter a valid tariff window");
    keys(window, ["months", "startMinute", "endMinute"]);
    if (
      !Array.isArray(window.months) ||
      window.months.length < 1 ||
      window.months.length > 12
    )
      throw new Error("Choose months for each tariff window");
    for (const month of window.months) {
      if (
        !Number.isInteger(month) ||
        month < 1 ||
        month > 12 ||
        months.has(month)
      )
        throw new Error("Each month can have only one tariff window");
      months.add(month);
    }
    for (const key of ["startMinute", "endMinute"]) {
      const minute = number(window[key], 0, 1439, "Enter tariff-window times");
      if (!Number.isInteger(minute) || minute % 15 !== 0)
        throw new Error("Tariff times must use 15-minute intervals");
    }
    if (window.startMinute === window.endMinute)
      throw new Error("The night tariff needs distinct start and end times");
  }
  keys(planning, [
    "maximumSoc",
    "solarMargin",
    "loadMargin",
    "fallbackDailyKwh",
    "heatingKwPerDegree",
    "heatingBaseC",
  ]);
  number(
    planning.maximumSoc,
    battery.reserveSoc,
    100,
    "Maximum target cannot be below the reserve",
  );
  if (!Number.isInteger(planning.maximumSoc))
    throw new Error("Choose a whole-number maximum target");
  number(
    planning.solarMargin,
    0.05,
    0.75,
    "Choose a solar uncertainty margin between 5% and 75%",
  );
  number(
    planning.loadMargin,
    0,
    1,
    "Choose a load uncertainty margin between 0% and 100%",
  );
  if (planning.fallbackDailyKwh !== null)
    number(
      planning.fallbackDailyKwh,
      0.1,
      10000,
      "Enter estimated household energy in kWh per day",
    );
  number(
    planning.heatingKwPerDegree,
    0,
    100,
    "Enter a valid heating sensitivity",
  );
  number(
    planning.heatingBaseC,
    -20,
    35,
    "Enter a valid heating base temperature",
  );
  if (loads.length > 12)
    throw new Error("Configure up to twelve flexible loads");
  for (const load of loads) {
    if (!record(load)) throw new Error("Enter a valid flexible load");
    keys(load, ["name", "powerKw", "durationMinutes"]);
    label(load.name, 80, "Name each flexible load");
    number(load.powerKw, 0.05, 100, "Enter flexible-load power in kW");
    const duration = number(
      load.durationMinutes,
      15,
      480,
      "Enter a load duration between 15 and 480 minutes",
    );
    if (!Number.isInteger(duration) || duration % 15 !== 0)
      throw new Error("Load duration must use 15-minute intervals");
  }
  return structuredClone(input);
}

/** @param {object} profile @returns {string[]} */
export function missingEnergyInputs(profile) {
  const missing = [];
  if (profile.site.latitude === null || profile.site.longitude === null)
    missing.push("location");
  if (profile.site.inverterKw === null) missing.push("inverter");
  if (!profile.site.arrays.length) missing.push("panels");
  if (profile.battery.capacityKwh === null) missing.push("battery");
  if (profile.tariff.dayPrice === null || profile.tariff.nightPrice === null)
    missing.push("prices");
  if (
    new Set(profile.tariff.windows.flatMap((window) => window.months)).size !==
    12
  )
    missing.push("tariff-hours");
  return missing;
}

/** @param {object} profile @returns {string} */
export function energyProfileHash(profile) {
  return hashValue(validateEnergyProfile(profile));
}

/** @param {unknown} value @returns {unknown} */
function canonical(value) {
  return Array.isArray(value)
    ? value.map(canonical)
    : record(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])]),
        )
      : value;
}
/** @param {unknown} value @returns {string} */
function hashValue(value) {
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}
/** @param {object} profile @returns {string} */
export function energySiteHash(profile) {
  return hashValue({
    version: ENERGY_MODEL_VERSION,
    timezone: profile.timezone,
    site: profile.site,
  });
}

/** @param {string} start @param {string} end @returns {object[]} */
export function fixedEnergyWindow(start, end) {
  return [
    {
      months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
      startMinute: energyMinute(start),
      endMinute: energyMinute(end),
    },
  ];
}
