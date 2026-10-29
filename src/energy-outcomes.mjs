import { dayStart, localDay } from "./analytics.mjs";
import { energyMeasuredBuckets } from "./energy-history.mjs";
import { energyTariff } from "./energy-time.mjs";

/** @param {object} forecast @param {object[]} rows @param {object} profile @param {number} now @returns {object[]} */
export function scoreEnergyForecast(
  forecast,
  rows,
  profile,
  now,
  options = {},
) {
  const buckets = options.buckets ?? energyMeasuredBuckets(rows),
    days = new Set(
      forecast.payload.slots.map((slot) =>
        localDay(slot.start, profile.timezone),
      ),
    ),
    result = [];
  for (const day of days) {
    if (options.excludedDays?.has(day)) continue;
    const start = dayStart(day, profile.timezone);
    const next = new Date(`${day}T12:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    const end = dayStart(next.toISOString().slice(0, 10), profile.timezone);
    if (end > now || new Date(forecast.fetched_at).getTime() >= start) continue;
    const slots = forecast.payload.slots.filter(
      (slot) => slot.start >= start && slot.end <= end,
    );
    if (
      slots.reduce((sum, slot) => sum + slot.end - slot.start, 0) !==
      end - start
    )
      continue;
    const actual = buckets.filter(
      (bucket) => bucket.start >= start && bucket.end <= end,
    );
    const coverage =
      actual.reduce((sum, bucket) => sum + bucket.coveredSeconds * 1000, 0) /
      (end - start);
    const sum = (key) =>
      actual.reduce((total, bucket) => total + bucket[key], 0);
    result.push({
      day,
      dayStart: new Date(start).toISOString(),
      forecastAt: new Date(forecast.fetched_at).toISOString(),
      assessedAt: new Date(now).toISOString(),
      coverage,
      curtailedPossible: actual.some((bucket) => bucket.curtailedPossible),
      rawCoveredSolarKwh: actual.reduce((sum, bucket) => {
        const slot = slots.find(
          (item) => item.start <= bucket.start && item.end >= bucket.end,
        );
        return sum + ((slot?.rawKw ?? 0) * bucket.coveredSeconds) / 3600;
      }, 0),
      rawSolarKwh: slots.reduce(
        (total, slot) =>
          total + (slot.rawKw * (slot.end - slot.start)) / 3600000,
        0,
      ),
      forecastSolarKwh: slots.reduce(
        (total, slot) =>
          total + (slot.expectedKw * (slot.end - slot.start)) / 3600000,
        0,
      ),
      actualSolarKwh: sum("solarKwh"),
      actualLoadKwh: sum("loadKwh"),
      actualImportKwh: sum("importKwh"),
      actualExportKwh: sum("exportKwh"),
      actualGridCost: actual.reduce((total, bucket) => {
        const price = energyTariff(profile, bucket.start);
        return (
          total + bucket.importKwh * price.buy - bucket.exportKwh * price.export
        );
      }, 0),
      estimated: true,
    });
  }
  return result;
}

/** @param {object} plan @param {object[]} rows @returns {object} */
export function scoreEnergyPlan(plan, rows, options = {}) {
  const prediction = plan.prediction,
    from = prediction.horizon.start,
    to = prediction.horizon.end;
  const buckets = (options.buckets ?? energyMeasuredBuckets(rows)).filter(
    (slot) => slot.start >= from && slot.end <= to,
  );
  const covered = buckets.reduce(
    (sum, slot) => sum + slot.coveredSeconds * 1000,
    0,
  );
  const cost = buckets.reduce((sum, slot) => {
    const tariff = energyTariff(plan.profile, slot.start);
    return sum + slot.importKwh * tariff.buy - slot.exportKwh * tariff.export;
  }, 0);
  const actualWear = buckets.reduce(
    (sum, bucket) =>
      sum + bucket.dischargeKwh * (plan.profile.tariff.cyclingCost ?? 0),
    0,
  );
  const baselineTimeline = prediction.baseline.timeline;
  const matchedBaseline = Array.isArray(baselineTimeline)
    ? buckets.reduce((sum, bucket) => {
        const slot = baselineTimeline.find(
          (item) => item.start === bucket.start && item.end === bucket.end,
        );
        return (
          sum +
          (slot ? slot.cost + (slot.cyclingCost ?? 0) : 0) * bucket.coverage
        );
      }, 0)
    : null;
  return {
    coverage: Math.min(1, covered / (to - from)),
    observedGridCost: cost,
    observedCyclingCost: actualWear,
    observedTotalCost: cost + actualWear,
    estimatedCounterfactualCostForCoveredPeriods: matchedBaseline,
    predictedGridCost: prediction.selected.gridCost,
    estimatedCounterfactualGridCost: prediction.baseline.gridCost,
    estimatedCounterfactualSavings:
      plan.state === "completed" &&
      !plan.code &&
      matchedBaseline !== null &&
      covered / (to - from) >= 0.8
        ? matchedBaseline - cost - actualWear
        : null,
    estimated: true,
  };
}

/** @param {{forecasts:object[],rows:object[],profile:object,now:number}} input @returns {object[]} */
export function scoreEnergyForecasts({ forecasts, rows, profile, now }) {
  const buckets = energyMeasuredBuckets(rows),
    excludedDays = new Set(),
    results = [];
  const latest = [...forecasts].sort(
    (a, b) =>
      new Date(b.fetched_at).getTime() - new Date(a.fetched_at).getTime(),
  );
  for (const forecast of latest)
    for (const outcome of scoreEnergyForecast(forecast, rows, profile, now, {
      buckets,
      excludedDays,
    })) {
      excludedDays.add(outcome.day);
      results.push({ forecastId: forecast.id, outcome });
    }
  return results;
}
