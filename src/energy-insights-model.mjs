import { energyMeasuredBuckets, energyQuantile } from "./energy-history.mjs";
import { energyLocalTime } from "./energy-time.mjs";
import { overlapsAway } from "./energy-occupancy.mjs";

/** @param {object} input @returns {object} */
export function assessEnergyInsights({ profile, rows, forecasts, away = [], online = true, now = Date.now() }) {
  const result = { at: new Date(now).toISOString(), consumption: { state: "unavailable" }, solar: { state: "unavailable" } };
  const last = rows.at(-1), age = now - new Date(last?.observed_at).getTime();
  if (!last || !Number.isFinite(age) || age > 600000 || age < -30000 || !online)
    return { ...result, consumption: { state: "stale" }, solar: { state: "stale" } };
  const end = Math.floor(now / 900000) * 900000, buckets = energyMeasuredBuckets(rows);
  const window = minutes => buckets.filter(bucket => bucket.start >= end - minutes * 60000 && bucket.end <= end);
  const complete = (values, count) => values.length === count && values.every(bucket => bucket.coverage >= 0.9);
  const recent = window(60);
  if (complete(recent, 4) && !overlapsAway(away, end - 3600000, end)) {
    const comparisons = recent.map(bucket => {
      const local = energyLocalTime(bucket.start, profile.timezone), weekend = [0, 6].includes(local.weekday);
      const prior = buckets.filter(value => value.end <= end - 86400000 && value.coverage >= 0.9 && !overlapsAway(away, value.start, value.end))
        .filter(value => Math.floor(energyLocalTime(value.start, profile.timezone).minute / 60) === Math.floor(local.minute / 60));
      const matching = prior.filter(value => [0, 6].includes(energyLocalTime(value.start, profile.timezone).weekday) === weekend);
      const days = values => new Set(values.map(value => energyLocalTime(value.start, profile.timezone).day)).size;
      const values = days(matching) >= 3 ? matching : days(prior) >= 7 ? prior : [];
      const median = energyQuantile(values.map(value => value.loadKwh / (value.coveredSeconds / 3600)), 0.5);
      const mad = median === null ? null : energyQuantile(values.map(value => Math.abs(value.loadKwh / (value.coveredSeconds / 3600) - median)), 0.5);
      return { actual: bucket.loadKwh / (bucket.coveredSeconds / 3600), median, threshold: median === null ? null : Math.max(median * 2, median + 1, median + 4 * (mad ?? 0)), days: days(values) };
    });
    if (comparisons.every(value => value.median !== null)) {
      const active = comparisons.every(value => value.actual > value.threshold);
      result.consumption = { state: active ? "active" : "healthy", kind: "consumption-high", from: new Date(end - 3600000).toISOString(), through: new Date(end).toISOString(), minutes: 60,
        actualKw: comparisons.reduce((sum, value) => sum + value.actual, 0) / 4,
        typicalKw: comparisons.reduce((sum, value) => sum + value.median, 0) / 4, referenceDays: Math.min(...comparisons.map(value => value.days)) };
    } else result.consumption = { state: "learning" };
  }
  const daylight = window(120);
  if (!complete(daylight, 8)) return result;
  if (rows.some(row => new Date(row.observed_at).getTime() >= end - 7200000 && row.soc >= 98) || daylight.some(value => value.curtailedPossible)) {
    result.solar = { state: "curtailment-possible" };
    return result;
  }
  let expectedKwh = 0;
  for (const bucket of daylight) {
    const record = [...forecasts].filter(value => new Date(value.fetched_at).getTime() <= bucket.start && bucket.start - new Date(value.fetched_at).getTime() <= 12 * 3600000)
      .sort((a, b) => new Date(b.fetched_at).getTime() - new Date(a.fetched_at).getTime())
      .find(value => value.payload.slots.some(slot => slot.start <= bucket.start && slot.end >= bucket.end));
    const slot = record?.payload.slots.find(value => value.start <= bucket.start && value.end >= bucket.end);
    if (!slot || !Number.isFinite(slot.lowKw) || slot.lowKw < 0.2) return result;
    expectedKwh += slot.lowKw * 0.25;
  }
  const actualKwh = daylight.reduce((sum, value) => sum + value.solarKwh, 0);
  if (expectedKwh >= 1.5) result.solar = { state: actualKwh < expectedKwh * 0.45 && expectedKwh - actualKwh >= 1 ? "active" : "healthy",
    kind: "solar-low", from: new Date(end - 7200000).toISOString(), through: new Date(end).toISOString(), minutes: 120, actualKwh, conservativeKwh: expectedKwh };
  return result;
}
