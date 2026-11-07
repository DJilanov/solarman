import test from "node:test";
import assert from "node:assert/strict";
import { validateAwayPeriod, awayAt, overlapsAway } from "../src/energy-occupancy.mjs";
import { learnEnergyDemand, predictEnergyDemand } from "../src/energy-history.mjs";
import { energyProfile, energyWeather } from "./fixtures/energy.mjs";

const now = Date.parse("2026-11-07T00:00:00.000Z");
const request = { startsAt: "2026-11-07T06:00:00.000Z", returnsAt: "2026-11-07T18:00:00.000Z", baselineW: 200 };
function readings(from, to, power) {
  const rows = [];
  for (let at = from; at <= to; at += 300000)
    rows.push({ observed_at: new Date(at), sampling_seconds: 300, pv_w: 0, grid_w: power(at), battery_w: 0, soc: 60, load_w: power(at) });
  return rows;
}

test("Away mode validates exact bounded dates and an explicit nonzero essential load", () => {
  const period = validateAwayPeriod(request, now);
  assert.equal(period.baselineW, 200);
  assert.equal(awayAt([period], period.start), period);
  assert.equal(awayAt([period], period.end), null);
  assert.equal(overlapsAway([period], period.end, period.end + 1000), false);
  for (const patch of [
    { baselineW: 0 }, { baselineW: NaN }, { baselineW: "200" }, { baselineW: 20001 },
    { startsAt: "2026-11-06T06:00:00.000Z" }, { returnsAt: request.startsAt },
    { returnsAt: "2028-11-07T18:00:00.000Z" }, { startsAt: "2026-11-07T06:01:00.000Z" },
    { startsAt: "2026-11-07T06:00:00" }, { startsAt: "invalid" },
  ]) assert.throws(() => validateAwayPeriod({ ...request, ...patch }, now));
});

test("Away predictions use essential demand only inside the period and return to normal without changing physical settings", () => {
  const profile = energyProfile(), original = JSON.stringify(profile);
  const rows = readings(now - 4 * 86400000, now, () => 1000);
  const weather = energyWeather(now).slots;
  const model = learnEnergyDemand(rows, profile, now);
  const period = { ...validateAwayPeriod(request, now), id: "trip" };
  const predicted = predictEnergyDemand(model, profile, weather, now, now + 86400000, [period]);
  assert.equal(predicted.find(s => s.start === period.start - 900000).expectedKw, 1);
  assert.equal(predicted.find(s => s.start === period.start).expectedKw, 0.2);
  assert.equal(predicted.find(s => s.start === period.end).expectedKw, 1);
  assert.equal(predicted.find(s => s.start === period.start).source, "away-estimate");
  assert.equal(predicted.find(s => s.start === period.start).awayPeriodId, "trip");
  assert.ok(predicted.find(s => s.start === period.start).highKw > 0.2);
  assert.equal(JSON.stringify(profile), original);
});

test("past Away consumption does not lower the household's normal learned demand", () => {
  const profile = energyProfile();
  const period = { start: now - 2 * 86400000, end: now - 86400000, baselineW: 100 };
  const rows = readings(now - 2 * 86400000, now, at => at < period.end ? 100 : 1000);
  const model = learnEnergyDemand(rows, profile, now, [], [period]);
  assert.ok(model.observations.every(s => s.kw >= 0.98));
  assert.ok(model.coveredHours < 25);
});

test("Away return remains an exclusive UTC boundary across a repeated local hour", () => {
  const profile = energyProfile(), from = Date.parse("2026-10-25T00:00:00Z");
  const rows = readings(from - 4 * 86400000, from, () => 1000);
  const model = learnEnergyDemand(rows, profile, from);
  const period = { start: from, end: from + 3600000, baselineW: 200, id: "clock-change" };
  const demand = predictEnergyDemand(model, profile, energyWeather(from).slots, from, from + 2 * 3600000, [period]);
  assert.equal(demand.filter(s => s.source === "away-estimate").reduce((sum, s) => sum + s.hours, 0), 1);
  assert.equal(demand.find(s => s.start === period.end).expectedKw, 1);
});

test("a saved normal-use estimate survives an absence longer than the measurement window without learning absence as normal", () => {
  const profile = energyProfile(); profile.planning.fallbackDailyKwh = null;
  const previous = learnEnergyDemand(readings(now - 4 * 86400000, now, () => 1000), profile, now);
  const later = now + 40 * 86400000;
  const period = { start: now + 86400000, end: later + 3600000, baselineW: 200, id: "long-trip" };
  const rows = readings(later - 28 * 86400000, later, () => 200);
  const model = learnEnergyDemand(rows, profile, later, [], [period], previous);
  assert.equal(model.ready, true);
  assert.equal(model.days, 0);
  assert.equal(model.quality, "limited");
  assert.ok(model.observations.every(slot => slot.kw === 1 && slot.source === "previous-normal-estimate"));
  const demand = predictEnergyDemand(model, profile, energyWeather(later).slots, later, later + 2 * 3600000, [period]);
  assert.equal(demand[0].expectedKw, 0.2);
  assert.equal(demand.find(slot => slot.start === period.end).expectedKw, 1);
  assert.ok(demand.find(slot => slot.start === period.end).highKw > 1);
  assert.equal(learnEnergyDemand(rows, profile, later, [], [period]).ready, false);
});
