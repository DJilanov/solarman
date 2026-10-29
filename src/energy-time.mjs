const formatters = new Map();
export const ENERGY_STEP_MS = 15 * 60_000;

/** @param {number} at @param {string} timezone @returns {{day:string,month:number,weekday:number,minute:number}} */
export function energyLocalTime(at, timezone) {
  if (!Number.isFinite(at)) throw new Error("Invalid energy-plan timestamp");
  let formatter = formatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(timezone, formatter);
  }
  const parts = Object.fromEntries(
    formatter.formatToParts(at).map((part) => [part.type, part.value]),
  );
  return {
    day: `${parts.year}-${parts.month}-${parts.day}`,
    month: Number(parts.month),
    weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(
      parts.weekday,
    ),
    minute: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

/** @param {unknown} value @returns {number} */
export function energyMinute(value) {
  if (typeof value !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value))
    throw new Error("Enter a tariff time in HH:MM format");
  const [hour, minute] = value.split(":").map(Number);
  if (minute % 15 !== 0)
    throw new Error("Tariff times must use 15-minute intervals");
  return hour * 60 + minute;
}

/** @param {number} minute @returns {string} */
export function energyTimeLabel(minute) {
  if (!Number.isInteger(minute) || minute < 0 || minute > 1439)
    throw new Error("Invalid tariff minute");
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}

/** @param {object} profile @param {number} at @returns {{night:boolean,buy:number,export:number}} */
export function energyTariff(profile, at) {
  const local = energyLocalTime(at, profile.timezone);
  const window = profile.tariff.windows.find((period) =>
    period.months.includes(local.month),
  );
  const night = Boolean(
    window &&
    (window.startMinute < window.endMinute
      ? local.minute >= window.startMinute && local.minute < window.endMinute
      : local.minute >= window.startMinute || local.minute < window.endMinute),
  );
  return {
    night,
    buy: night ? profile.tariff.nightPrice : profile.tariff.dayPrice,
    export: profile.tariff.exportPrice,
  };
}

/** @param {number} from @param {number} to @returns {{start:number,end:number,hours:number}[]} */
export function energyIntervals(from, to) {
  if (
    !Number.isFinite(from) ||
    !Number.isFinite(to) ||
    to <= from ||
    to - from > 8 * 86400_000
  )
    throw new Error("Invalid energy-plan horizon");
  const intervals = [];
  for (let at = from; at < to;) {
    const end = Math.min(
      to,
      (Math.floor(at / ENERGY_STEP_MS) + 1) * ENERGY_STEP_MS,
    );
    intervals.push({ start: at, end, hours: (end - at) / 3600_000 });
    at = end;
  }
  return intervals;
}

/** @param {object} profile @param {number} now @returns {{start:number,end:number}[]} */
export function energyNightWindows(profile, now) {
  const intervals = energyIntervals(
    Math.floor(now / ENERGY_STEP_MS) * ENERGY_STEP_MS - 86400_000,
    now + 4 * 86400_000,
  );
  const windows = [];
  for (const interval of intervals) {
    if (!energyTariff(profile, interval.start).night) continue;
    const previous = windows.at(-1);
    if (previous?.end === interval.start) previous.end = interval.end;
    else windows.push({ start: interval.start, end: interval.end });
  }
  return windows.filter((window) => window.end > now);
}

/** @param {number} at @param {string} timezone @returns {number} */
export function energyNativeTime(at, timezone) {
  const minute = energyLocalTime(at, timezone).minute;
  return Math.floor(minute / 60) * 256 + (minute % 60);
}
