import { createHash } from "node:crypto";
import { positiveEnergy } from "./analytics.mjs";
import { energyIntervals, energyLocalTime } from "./energy-time.mjs";

/** @param {number[]} values @param {number} fraction @returns {number|null} */
export function energyQuantile(values, fraction) {
  if (!Number.isFinite(fraction)) throw new Error("Invalid energy quantile");
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const at = Math.max(0, Math.min(1, fraction)) * (sorted.length - 1),
    left = Math.floor(at);
  return sorted[left] + (sorted[Math.ceil(at)] - sorted[left]) * (at - left);
}

/** @param {object[]} rows @returns {object[]} */
export function energyMeasuredBuckets(rows) {
  const numeric = (value) =>
    value === null || value === undefined || typeof value === "boolean"
      ? NaN
      : Number(value);
  const samples = rows
    .filter((row) => row.observed_at !== null && row.observed_at !== undefined)
    .map((row) => ({
      at: new Date(row.observed_at).getTime(),
      pv: numeric(row.pv_w),
      load: numeric(row.load_w),
      grid: numeric(row.grid_w),
      battery: numeric(row.battery_w),
      soc: numeric(row.soc),
      cadence: Number(row.sampling_seconds) || 300,
    }))
    .filter(
      (row) =>
        [row.at, row.pv, row.load, row.grid, row.battery, row.soc].every(
          Number.isFinite,
        ) &&
        row.pv >= 0 &&
        row.load >= 0 &&
        row.soc >= 0 &&
        row.soc <= 100 &&
        row.cadence >= 30 &&
        row.cadence <= 1800,
    )
    .sort((a, b) => a.at - b.at);
  const buckets = new Map();
  for (let index = 1; index < samples.length; index++) {
    const first = samples[index - 1],
      last = samples[index],
      span = last.at - first.at;
    if (span <= 0 || span > 2 * Math.max(first.cadence, last.cadence) * 1000)
      continue;
    for (const interval of energyIntervals(first.at, last.at)) {
      const key = Math.floor(interval.start / 900000) * 900000;
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = {
          start: key,
          end: key + 900000,
          coveredSeconds: 0,
          solarKwh: 0,
          loadKwh: 0,
          importKwh: 0,
          exportKwh: 0,
          chargeKwh: 0,
          dischargeKwh: 0,
          curtailedPossible: false,
        };
        buckets.set(key, bucket);
      }
      const values = {};
      for (const name of ["pv", "load", "grid", "battery", "soc"])
        values[name] = [
          first[name] +
            ((last[name] - first[name]) * (interval.start - first.at)) / span,
          first[name] +
            ((last[name] - first[name]) * (interval.end - first.at)) / span,
        ];
      bucket.coveredSeconds += (interval.end - interval.start) / 1000;
      bucket.solarKwh += positiveEnergy(...values.pv, interval.hours);
      bucket.loadKwh += positiveEnergy(...values.load, interval.hours);
      bucket.importKwh += positiveEnergy(...values.grid, interval.hours);
      bucket.exportKwh += positiveEnergy(
        -values.grid[0],
        -values.grid[1],
        interval.hours,
      );
      bucket.chargeKwh += positiveEnergy(
        -values.battery[0],
        -values.battery[1],
        interval.hours,
      );
      bucket.dischargeKwh += positiveEnergy(...values.battery, interval.hours);
      bucket.curtailedPossible ||=
        Math.max(...values.soc) >= 98 &&
        Math.max(...values.pv) > 100 &&
        Math.max(...values.pv) >= Math.min(...values.load) &&
        Math.min(...values.grid) > -100 &&
        Math.min(...values.battery) > -100;
    }
  }
  return [...buckets.values()].map((bucket) => ({
    ...bucket,
    coverage: Math.min(1, bucket.coveredSeconds / 900),
  }));
}

/** @param {object[]} rows @param {object} profile @param {number} now @returns {object} */
export function learnEnergyDemand(rows, profile, now, weather = []) {
  const buckets = energyMeasuredBuckets(
    rows.filter((row) => new Date(row.observed_at).getTime() <= now),
  );
  const groups = new Map(),
    hours = new Map(),
    temperatures = new Map(),
    days = new Set();
  let energy = 0,
    coveredHours = 0;
  for (const bucket of buckets) {
    if (bucket.coverage < 0.5) continue;
    const local = energyLocalTime(bucket.start, profile.timezone),
      hour = Math.floor(local.minute / 60),
      weekend = local.weekday === 0 || local.weekday === 6;
    const kw = bucket.loadKwh / (bucket.coveredSeconds / 3600);
    const key = `${weekend ? 1 : 0}:${hour}`;
    const temperature = weather.find(
      (slot) => slot.start <= bucket.start && slot.end > bucket.start,
    )?.temperatureC;
    if (Number.isFinite(temperature))
      temperatures.set(hour, [...(temperatures.get(hour) ?? []), temperature]);
    groups.set(key, [...(groups.get(key) ?? []), kw]);
    hours.set(hour, [...(hours.get(hour) ?? []), kw]);
    days.add(local.day);
    energy += bucket.loadKwh;
    coveredHours += bucket.coveredSeconds / 3600;
  }
  const fallback =
    profile.planning.fallbackDailyKwh !== null
      ? profile.planning.fallbackDailyKwh / 24
      : coveredHours >= 6
        ? energy / coveredHours
        : null;
  const observations = [];
  let imputed = 0;
  for (let weekend = 0; weekend < 2; weekend++)
    for (let hour = 0; hour < 24; hour++) {
      const own = groups.get(`${weekend}:${hour}`) ?? [],
        values = own.length >= 4 ? own : (hours.get(hour) ?? []);
      const kw = energyQuantile(values, 0.5) ?? fallback;
      if (!values.length) imputed++;
      observations.push({
        weekend: Boolean(weekend),
        hour,
        kw,
        referenceTemperatureC: energyQuantile(
          temperatures.get(hour) ?? [],
          0.5,
        ),
        samples: values.length,
        source:
          own.length >= 4
            ? "day-type"
            : values.length
              ? "all-days"
              : profile.planning.fallbackDailyKwh !== null
                ? "configured-estimate"
                : "observed-average",
      });
    }
  const ready = observations.every((slot) => slot.kw !== null);
  const quality = !ready
    ? "missing"
    : days.size >= 14 && imputed === 0
      ? "established"
      : days.size >= 7 && imputed <= 4
        ? "developing"
        : "limited";
  return {
    ready,
    quality,
    days: days.size,
    coveredHours,
    imputedHours: imputed,
    observations,
    asOf: new Date(now).toISOString(),
    version: createHash("sha256")
      .update(
        JSON.stringify({
          observations,
          days: days.size,
          asOf: Math.floor(now / 3600000),
        }),
      )
      .digest("hex"),
  };
}

/** @param {object} model @param {object} profile @param {object[]} weather @param {number} from @param {number} to @returns {object[]} */
export function predictEnergyDemand(model, profile, weather, from, to) {
  if (!model.ready)
    throw new Error(
      "More household readings or a daily consumption estimate are required",
    );
  return energyIntervals(from, to).map((interval) => {
    const local = energyLocalTime(interval.start, profile.timezone),
      weekend = local.weekday === 0 || local.weekday === 6;
    const observed = model.observations.find(
      (item) =>
        item.hour === Math.floor(local.minute / 60) && item.weekend === weekend,
    );
    const forecast = weather.find(
      (item) => item.start <= interval.start && item.end > interval.start,
    );
    if (!forecast)
      throw new Error("The weather forecast does not cover the plan horizon");
    const reference =
      observed.referenceTemperatureC ??
      (observed.source === "configured-estimate"
        ? profile.planning.heatingBaseC
        : null);
    const heating =
      reference === null
        ? 0
        : profile.planning.heatingKwPerDegree *
          (Math.max(0, profile.planning.heatingBaseC - forecast.temperatureC) -
            Math.max(0, profile.planning.heatingBaseC - reference));
    const expectedKw = Math.max(0, observed.kw + heating),
      margin =
        profile.planning.loadMargin + (model.quality === "limited" ? 0.15 : 0);
    return {
      ...interval,
      expectedKw,
      lowKw: Math.max(0, expectedKw * (1 - margin)),
      highKw: expectedKw * (1 + margin),
      source: observed.source,
    };
  });
}

/** @param {object[]} outcomes @param {number} margin @param {number} now @returns {object} */
export function calibrateEnergySolar(outcomes, margin, now) {
  const eligible = outcomes.filter(
    (row) =>
      row.coverage >= 0.95 &&
      !row.curtailedPossible &&
      (row.rawCoveredSolarKwh ?? row.rawSolarKwh) > 0.5 &&
      row.actualSolarKwh >= 0 &&
      Date.parse(row.assessedAt) <= now &&
      Date.parse(row.forecastAt) < Date.parse(row.dayStart),
  );
  const days = new Map();
  for (const row of eligible) {
    const key = row.dayStart;
    const prior = days.get(key);
    if (!prior || Date.parse(row.forecastAt) > Date.parse(prior.forecastAt))
      days.set(key, row);
  }
  const ratios = [...days.values()]
    .sort((a, b) => Date.parse(a.dayStart) - Date.parse(b.dayStart))
    .slice(-28)
    .map(
      (row) => row.actualSolarKwh / (row.rawCoveredSolarKwh ?? row.rawSolarKwh),
    )
    .filter((value) => Number.isFinite(value) && value > 0.1 && value < 3);
  const learned = ratios.length >= 7;
  const scale = learned
    ? Math.max(0.5, Math.min(1.5, energyQuantile(ratios, 0.5)))
    : 1;
  const lowScale = learned
    ? Math.max(0.1, Math.min(scale, energyQuantile(ratios, 0.15)))
    : 1 - margin;
  const highScale = learned
    ? Math.min(2, Math.max(scale, energyQuantile(ratios, 0.85)))
    : 1 + margin;
  return {
    scale,
    lowScale,
    highScale,
    days: ratios.length,
    source: learned ? "observed-error-range" : "configured-scenarios",
    version: createHash("sha256")
      .update(JSON.stringify({ ratios, margin }))
      .digest("hex"),
  };
}

/** @param {object} profile @param {object|null} reading @param {object[]} rows @param {number} now @param {number|null} [nativeFloor] @returns {object|null} */
export function estimateBackupEndurance(
  profile,
  reading,
  rows,
  now,
  nativeFloor = null,
) {
  if (
    !reading ||
    profile.battery.capacityKwh === null ||
    !Number.isFinite(reading.soc) ||
    reading.soc < 0 ||
    reading.soc > 100 ||
    !Number.isFinite(Date.parse(reading.at)) ||
    now - Date.parse(reading.at) > 15 * 60000 ||
    Date.parse(reading.at) > now + 30000
  )
    return null;
  const recent = rows
    .filter(
      (row) =>
        new Date(row.observed_at).getTime() >= now - 60 * 60000 &&
        new Date(row.observed_at).getTime() <= now,
    )
    .map((row) => Number(row.load_w))
    .filter((value) => Number.isFinite(value) && value >= 50);
  const load = profile.battery.essentialLoadW ?? energyQuantile(recent, 0.5);
  if (load === null) return null;
  const floor = Math.max(profile.battery.backupFloorSoc, nativeFloor ?? 0);
  const availableKwh =
    Math.max(0, ((reading.soc - floor) / 100) * profile.battery.capacityKwh) *
    profile.battery.dischargeEfficiency;
  const lowLoad =
      profile.battery.essentialLoadW ?? energyQuantile(recent, 0.15) ?? load,
    highLoad =
      profile.battery.essentialLoadW ?? energyQuantile(recent, 0.85) ?? load;
  return {
    estimated: true,
    availableKwh,
    floorSoc: floor,
    loadW: load,
    loadSource:
      profile.battery.essentialLoadW !== null
        ? "configured-essential-load"
        : "recent-household-load",
    hours: availableKwh / (load / 1000),
    lowHours: availableKwh / (Math.max(50, highLoad) / 1000),
    highHours: availableKwh / (Math.max(50, lowLoad) / 1000),
    powerLimitExceeded:
      profile.battery.powerConfirmed &&
      load > profile.battery.dischargeKw * 1000,
    powerLimitKnown: profile.battery.powerConfirmed,
    assumedFloor: nativeFloor === null,
  };
}

/** @param {object[]} timeline @param {object[]} loads @returns {object[]} */
export function suggestSurplusLoads(timeline, loads) {
  return loads.map((load) => {
    let best = null;
    for (let index = 0; index < timeline.length; index++) {
      const start = timeline[index].start,
        end = start + load.durationMinutes * 60000;
      let covered = 0,
        minimum = Infinity;
      for (
        let offset = index;
        offset < timeline.length && timeline[offset].start < end;
        offset++
      ) {
        const slot = timeline[offset];
        if (offset > index && timeline[offset - 1].end !== slot.start) break;
        const hours =
          (Math.min(end, slot.end) - Math.max(start, slot.start)) / 3600000;
        if (hours <= 0) continue;
        const kw = slot.surplusKw;
        if (kw < load.powerKw) break;
        covered += hours;
        minimum = Math.min(minimum, kw);
      }
      if (covered + 1e-9 < load.durationMinutes / 60) continue;
      if (!best || minimum > best.surplusKw)
        best = { start, end, surplusKw: minimum };
    }
    return {
      name: load.name,
      powerKw: load.powerKw,
      durationMinutes: load.durationMinutes,
      slot: best,
      advisory: true,
    };
  });
}
