const formatterCache = new Map();

/** @param {number | Date} instant @param {string} timezone @returns {object} */
function dateParts(instant, timezone) {
  if (!formatterCache.has(timezone))
    formatterCache.set(
      timezone,
      new Intl.DateTimeFormat("en-CA", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
      }),
    );
  return Object.fromEntries(
    formatterCache
      .get(timezone)
      .formatToParts(instant)
      .map((p) => [p.type, p.value]),
  );
}

/** @param {number | Date} instant @param {string} timezone @returns {string} */
export function localDay(instant, timezone = "Europe/Sofia") {
  const p = dateParts(instant, timezone);
  return `${p.year}-${p.month}-${p.day}`;
}

/** @param {string} day @param {number} count @returns {string} */
export function addDays(day, count) {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
}

/** @param {string} day @param {string} timezone @returns {number} */
export function dayStart(day, timezone = "Europe/Sofia") {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error("Invalid date");
  const target = Date.parse(`${day}T00:00:00Z`);
  if (
    !Number.isFinite(target) ||
    new Date(target).toISOString().slice(0, 10) !== day
  )
    throw new Error("Invalid date");
  let guess = target;
  for (let i = 0; i < 4; i++) {
    const p = dateParts(guess, timezone);
    const displayed = Date.UTC(
      Number(p.year),
      Number(p.month) - 1,
      Number(p.day),
      Number(p.hour),
      Number(p.minute),
      Number(p.second),
    );
    const next = target - (displayed - Math.floor(guess / 1000) * 1000);
    if (next === guess) break;
    guess = next;
  }
  return guess;
}

/** @param {number} from @param {number} to @param {number} hours @returns {number} */
export function positiveEnergy(from, to, hours) {
  if (from >= 0 && to >= 0) return (((from + to) / 2) * hours) / 1000;
  if (from <= 0 && to <= 0) return 0;
  const crossing = -from / (to - from);
  return (
    (((from > 0 ? from * crossing : to * (1 - crossing)) / 2) * hours) / 1000
  );
}

/** @returns {object} */
function emptyEnergy() {
  return {
    solarKwh: 0,
    loadKwh: 0,
    importKwh: 0,
    exportKwh: 0,
    chargeKwh: 0,
    dischargeKwh: 0,
    coveredSeconds: 0,
  };
}

/** @param {object[]} rows @param {{ start: number, end: number, pollMs: number, timezone?: string, fullResolution?: boolean }} options @returns {object} */
export function summarize(
  rows,
  { start, end, pollMs, timezone = "Europe/Sofia", fullResolution = false },
) {
  const total = emptyEnergy();
  const days = new Map();
  const samples = [];
  for (const row of rows) {
    const at = new Date(row.observed_at).getTime();
    const point = {
      at,
      soc: Number(row.soc),
      pvW: Number(row.pv_w),
      loadW: Number(row.load_w),
      gridW: Number(row.grid_w),
      batteryW: Number(row.battery_w),
      temperatureC: Number(row.temperature_c),
    };
    if (Object.values(point).every(Number.isFinite)) samples.push(point);
  }
  samples.sort((a, b) => a.at - b.at);
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1];
    const b = samples[i];
    const span = b.at - a.at;
    if (span <= 0 || span > pollMs * 2 || b.at <= start || a.at >= end)
      continue;
    let left = Math.max(start, a.at);
    const right = Math.min(end, b.at);
    while (left < right) {
      const day = localDay(left, timezone);
      const stop = Math.min(right, dayStart(addDays(day, 1), timezone));
      if (stop <= left) throw new Error("Invalid analytics day boundary");
      const hours = (stop - left) / 3_600_000;
      const interpolate = (field, time) =>
        a[field] + ((b[field] - a[field]) * (time - a.at)) / span;
      const energy = emptyEnergy();
      energy.solarKwh = positiveEnergy(
        interpolate("pvW", left),
        interpolate("pvW", stop),
        hours,
      );
      energy.loadKwh = positiveEnergy(
        interpolate("loadW", left),
        interpolate("loadW", stop),
        hours,
      );
      energy.importKwh = positiveEnergy(
        interpolate("gridW", left),
        interpolate("gridW", stop),
        hours,
      );
      energy.exportKwh = positiveEnergy(
        -interpolate("gridW", left),
        -interpolate("gridW", stop),
        hours,
      );
      energy.dischargeKwh = positiveEnergy(
        interpolate("batteryW", left),
        interpolate("batteryW", stop),
        hours,
      );
      energy.chargeKwh = positiveEnergy(
        -interpolate("batteryW", left),
        -interpolate("batteryW", stop),
        hours,
      );
      energy.coveredSeconds = (stop - left) / 1000;
      if (!days.has(day)) days.set(day, { day, ...emptyEnergy() });
      for (const key of Object.keys(total)) {
        total[key] += energy[key];
        days.get(day)[key] += energy[key];
      }
      left = stop;
    }
  }
  const selected = samples.filter((p) => p.at >= start && p.at <= end);
  const stride = fullResolution
    ? 1
    : Math.max(1, Math.ceil(selected.length / 900));
  const points = [];
  for (let i = 0; i < selected.length; i++) {
    const current = selected[i];
    const previous = selected[i - 1];
    if (!fullResolution && previous && current.at - previous.at > pollMs * 2) {
      points.push({
        at: previous.at + 1,
        pvW: null,
        loadW: null,
        gridW: null,
        batteryW: null,
        soc: null,
        temperatureC: null,
      });
    }
    if (i % stride === 0 || i === selected.length - 1) points.push(current);
  }
  return {
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
    timezone,
    estimated: true,
    sampleCount: selected.length,
    coverage:
      end > start
        ? Math.min(1, (total.coveredSeconds * 1000) / (end - start))
        : 0,
    totals: total.coveredSeconds > 0 ? total : null,
    daily: [...days.values()].sort((a, b) => a.day.localeCompare(b.day)),
    points,
  };
}
