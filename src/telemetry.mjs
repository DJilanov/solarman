export const BLUESUN_MAPPING = "bluesun-bse20kh3/2.02";
export const TELEMETRY_MAX_AGE_MS = 600_000;

/** @typedef {{key: string, value: string, name: string, unit: string}} ProviderPoint */
/** @typedef {{collectedAt: Date, deviceState: number, points: ProviderPoint[]}} ProviderReading */
/** @param {unknown} value @returns {value is Record<string, unknown>} */
function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** @param {unknown} value @param {string} device @param {number} [now] @returns {ProviderReading} */
export function parseProviderReading(value, device, now = Date.now()) {
  if (
    !object(value) ||
    value.deviceSn !== device ||
    value.deviceType !== "INVERTER"
  )
    throw new Error("Provider readings do not match the selected inverter");
  const seconds =
    typeof value.collectionTime === "number" ||
    typeof value.collectionTime === "string"
      ? Number(value.collectionTime)
      : NaN;
  const collected = seconds * 1000;
  if (
    !Number.isSafeInteger(seconds) ||
    collected < now - 366 * 86400_000 ||
    collected > now + 30_000 ||
    !Array.isArray(value.dataList) ||
    value.dataList.length > 2000 ||
    typeof value.deviceState !== "number" ||
    ![1, 2, 3].includes(value.deviceState)
  )
    throw new Error("Provider readings have an invalid format or timestamp");
  const points = [];
  const keys = new Set();
  for (const item of value.dataList) {
    if (
      !object(item) ||
      typeof item.key !== "string" ||
      !item.key ||
      item.key.length > 200 ||
      !["string", "number"].includes(typeof item.value) ||
      /password|secret|token|credential/i.test(item.key + " " + item.name)
    )
      continue;
    if (keys.has(item.key))
      throw new Error("Provider readings contain duplicate parameter keys");
    keys.add(item.key);
    points.push({
      key: item.key,
      value: String(item.value).slice(0, 1000),
      name: typeof item.name === "string" ? item.name.slice(0, 200) : item.key,
      unit: typeof item.unit === "string" ? item.unit.slice(0, 30) : "",
    });
  }
  return {
    collectedAt: new Date(collected),
    deviceState: value.deviceState,
    points,
  };
}

/** @param {ProviderReading} reading @param {string} timezone @returns {{passed: boolean, skewSeconds: number | null, reportedTime: string | null}} */
export function checkInverterClock(reading, timezone) {
  const time =
    reading.points.find((point) => point.key === "SYSTIM1")?.value ?? null;
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(
    time ?? "",
  );
  if (!match) return { passed: false, skewSeconds: null, reportedTime: time };
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  const reported = Date.UTC(year, month - 1, day, hour, minute, second);
  const roundTrip = new Date(reported);
  if (
    roundTrip.getUTCFullYear() !== year ||
    roundTrip.getUTCMonth() !== month - 1 ||
    roundTrip.getUTCDate() !== day ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  )
    return { passed: false, skewSeconds: null, reportedTime: time };
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(reading.collectedAt)
      .map((part) => [part.type, part.value]),
  );
  const local = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  const skewSeconds = Math.abs(reported - local) / 1000;
  return { passed: skewSeconds <= 120, skewSeconds, reportedTime: time };
}

/** @param {unknown} value @returns {string | null} */
export function firmwareVersion(value) {
  return typeof value === "string" &&
    /^\d{1,4}(?:\.\d{1,4}){1,3}$/.test(value.trim())
    ? value.trim()
    : null;
}

/** @param {ProviderReading} reading @returns {{protocol: string | null, dsp: string | null, hmi: string | null}} */
export function providerFirmware(reading) {
  const points = new Map(reading.points.map((point) => [point.key, point]));
  return {
    protocol: firmwareVersion(points.get("PTCv1")?.value),
    dsp: firmwareVersion(points.get("DSP_V_M")?.value),
    hmi: firmwareVersion(points.get("HMIVN")?.value),
  };
}

/** @param {ProviderReading} reading @param {string} timezone @param {number} [now] @returns {{snapshot: {soc: number, temperatureC: number, pvW: number, loadW: number, gridW: number, batteryW: number}, clock: ReturnType<typeof checkInverterClock>, versions: {protocol: string, dsp: string | null, hmi: string | null}}} */
export function normalizeBluesun(reading, timezone, now = Date.now()) {
  const points = new Map(reading.points.map((point) => [point.key, point]));
  if (
    points.get("MMN")?.value.trim() !== "BSE20KH3" ||
    points.get("PTCv1")?.value.trim() !== "2.02"
  )
    throw new Error(
      "The telemetry mapping requires Bluesun BSE20KH3 protocol 2.02",
    );
  if (reading.deviceState !== 1)
    throw new Error("The inverter is offline or reporting an alarm");
  if (now - reading.collectedAt.getTime() > TELEMETRY_MAX_AGE_MS)
    throw new Error("The provider has not supplied fresh device readings");
  /** @param {string} key @param {string[]} units @param {number} minimum @param {number} maximum @returns {number} */
  const number = (key, units, minimum, maximum) => {
    const point = points.get(key);
    if (
      !point ||
      !units.includes(point.unit) ||
      !/^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(point.value.trim())
    )
      throw new Error(`Invalid telemetry value: ${key}`);
    const value = Number(point.value);
    if (!Number.isFinite(value) || value < minimum || value > maximum)
      throw new Error(`Invalid telemetry value: ${key}`);
    return value;
  };
  if (number("Pr1", ["W"], 1, 100_000) !== 20000)
    throw new Error("The telemetry mapping requires a 20 kW inverter rating");
  const soc = number("B_left_cap1", ["%"], 0, 100);
  if (!Number.isInteger(soc))
    throw new Error("Invalid telemetry value: B_left_cap1");
  return {
    snapshot: {
      soc,
      pvW: number("PVTP", ["W"], 0, 100_000),
      loadW: number("EP", ["W"], 0, 100_000),
      gridW: number("PG_Pt1", ["W"], -100_000, 100_000),
      batteryW: number("B_P1", ["W"], -30_000, 30_000),
      temperatureC: number("B_T1", ["℃", "°C"], -50, 100),
    },
    clock: checkInverterClock(reading, timezone),
    versions: { ...providerFirmware(reading), protocol: "2.02" },
  };
}
