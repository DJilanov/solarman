import test from "node:test";
import assert from "node:assert/strict";
import { energyProfile } from "./fixtures/energy.mjs";
import { validateOutageRequest, planOutage, validateLoadTask, planLoadTask, weeklyEnergyReport, energyLearning, hourlySolarLearning } from "../src/energy-tools-model.mjs";

const now = Date.parse("2026-10-30T08:00:00Z");
function readings(from, to, values = {}) {
  const rows = [];
  for (let at = from; at <= to; at += 300000) rows.push({ id: String(rows.length + 1), observed_at: new Date(at), received_at: new Date(at + 1000), sampling_seconds: 300,
    soc: 50, pv_w: 0, load_w: 1000, grid_w: 1000, battery_w: 0, reading_source: "provider", ...values });
  return rows;
}
function solar(from, to, power = 0) {
  const slots = [];
  for (let at = Math.floor(from / 3600000) * 3600000; at < to; at += 3600000)
    slots.push({ start: at, end: at + 3600000, rawKw: power, expectedKw: power, lowKw: power, highKw: power });
  return slots;
}

test("outage planning recommends a feasible reserve and reports the time needed to charge", () => {
  const profile = energyProfile(), rows = readings(now - 86400000, now);
  const request = validateOutageRequest({ startsAt: new Date(now + 4 * 3600000).toISOString(), hours: 10, mode: "essential", essentialW: 1000 }, now);
  const plan = planOutage(profile, rows, [], request, now);
  assert.equal(plan.targetSoc, 63);
  assert.equal(plan.feasible, true);
  assert.equal(plan.readyBeforeStart, true);
  assert.ok(plan.chargingHours > 1.3 && plan.chargingHours < 1.4);
  assert.equal(plan.solarCoverage, 0);
  assert.equal(plan.conservativeSolarKwh, 0);
  assert.ok(plan.currentShortfallKwh > 2);
});

test("outage planning exposes capacity, output-power and deadline shortfalls", () => {
  const profile = energyProfile(), rows = readings(now - 86400000, now);
  profile.battery.dischargeKw = 2;
  const request = validateOutageRequest({ startsAt: new Date(now + 60000).toISOString(), hours: 10, mode: "essential", essentialW: 3000 }, now);
  const plan = planOutage(profile, rows, [], request, now);
  assert.equal(plan.targetSoc, 100);
  assert.equal(plan.feasible, false);
  assert.equal(plan.readyBeforeStart, false);
  assert.ok(plan.shortfallKwh > 10);
  assert.ok(plan.powerShortfallKwh > 9.9);
  assert.throws(() => planOutage(profile, rows.slice(0, -4), [], request, now), /Fresh battery/);
});

test("outage simulation uses solar in chronological order without spending later generation early", () => {
  const profile = energyProfile(), rows = readings(now - 86400000, now);
  const request = validateOutageRequest({ startsAt: new Date(now + 3600000).toISOString(), hours: 4, mode: "essential", essentialW: 3000 }, now);
  const sunny = solar(request.start, request.end, 0);
  sunny.at(-1).lowKw = 20;
  const result = planOutage(profile, rows, sunny, request, now);
  assert.ok(result.targetSoc > 50, "the first three hours must be covered before the late solar arrives");
  assert.equal(result.solarCoverage, 1);
  assert.throws(() => validateOutageRequest({ startsAt: "invalid", hours: 10, mode: "essential", essentialW: 500 }, now), /start/);
  assert.throws(() => validateOutageRequest({ startsAt: new Date(now).toISOString(), hours: 73, mode: "essential", essentialW: 500 }, now), /duration/);
});

test("appliance planning chooses conservative solar surplus and respects an exact non-quarter-hour deadline", () => {
  const profile = energyProfile(), rows = readings(now - 86400000, now);
  const forecasts = solar(now, now + 8 * 3600000);
  for (const slot of [forecasts[3], forecasts[4]]) slot.rawKw = slot.expectedKw = slot.lowKw = 10;
  const input = validateLoadTask({ name: "Water heater", powerKw: 2, durationMinutes: 120,
    earliestAt: new Date(now).toISOString(), deadlineAt: new Date(now + 8 * 3600000).toISOString(), reminderEnabled: true }, now);
  const result = planLoadTask(profile, forecasts, rows, input);
  assert.equal(result.suggestedAt, new Date(now + 3 * 3600000).toISOString());
  assert.equal(result.solarKwh, 4);
  assert.equal(result.switchesAppliance, false);
  assert.equal(result.batteryPriority, true);
  for (const slot of [forecasts[3], forecasts[4]]) slot.rawKw = slot.expectedKw = slot.lowKw = 4;
  const reserved = planLoadTask(profile, forecasts, rows, input);
  assert.equal(reserved.solarKwh, 0, "solar reserved for battery charging is unavailable for an appliance");
  const narrow = { ...input, earliest: now + 60000, deadline: now + 16 * 60000, durationMinutes: 15 };
  assert.equal(planLoadTask(profile, forecasts, rows, narrow).suggestedAt, new Date(now + 60000).toISOString());
  assert.throws(() => planLoadTask(profile, [], rows, input), /forecast/);
  assert.throws(() => validateLoadTask({ ...input, name: "", earliestAt: "invalid" }, now), /Name/);
});

test("weekly reporting keeps real coverage and accounts for the 25-hour clock-change day", () => {
  const profile = energyProfile(), end = Date.parse("2026-10-29T22:00Z"), start = Date.parse("2026-10-22T21:00Z");
  const report = weeklyEnergyReport(profile, readings(start, end), [], now);
  assert.equal(report.days.length, 7);
  assert.equal(report.fromDay, "2026-10-23");
  assert.equal(report.coverage, 1);
  assert.ok(Math.abs(report.importKwh - 169) < 1e-8);
  assert.equal(report.estimatedSavings, null);
  const missing = weeklyEnergyReport(profile, [], [], now);
  assert.equal(missing.coverage, 0);
  assert.equal(missing.assessedPlans, 0);
});

test("battery learning requires a continuous substantial discharge and never changes configured capacity", () => {
  const rows = readings(now - 2 * 3600000, now, { battery_w: 2000, soc: 80 });
  for (let i = 0; i < rows.length; i++) rows[i].soc = 80 - 20 * i / (rows.length - 1);
  rows.push({ ...rows.at(-1), observed_at: new Date(now + 300000), battery_w: 0, soc: 60 });
  const learned = energyLearning([], rows, { now: now + 300000 });
  assert.equal(learned.qualifyingCycles, 1);
  assert.ok(Math.abs(learned.observedFullCapacityKwh - 20) < 1e-8);
  assert.equal(learned.batteryEstimateChangesSettings, false);
  assert.equal(energyLearning([], rows.filter((_, i) => i < 10 || i > 20), { now }).qualifyingCycles, 0);
});

test("hourly learning uses forecasts frozen before the day and excludes curtailed generation", () => {
  const start = Date.parse("2026-10-22T08:00Z"), rows = readings(start, start + 3600000, { pv_w: 1000, load_w: 2000, grid_w: 1000 });
  const payload = { slots: solar(start, start + 3600000, 2) };
  const records = [{ fetched_at: new Date(start - 86400000), payload }];
  const result = hourlySolarLearning(records, rows, "Europe/Sofia", now);
  assert.equal(result[11].days, 1);
  assert.ok(Math.abs(result[11].rawScale - 0.5) < 1e-8);
  assert.equal(hourlySolarLearning([{ fetched_at: new Date(start), payload }], rows, "Europe/Sofia", now)[11].days, 0);
  const curtailed = rows.map(r => ({ ...r, soc: 100, battery_w: 0, grid_w: 0, load_w: 500 }));
  assert.equal(hourlySolarLearning(records, curtailed, "Europe/Sofia", now)[11].days, 0);
});

test("forecast learning counts complete distinct days and rejects non-finite energy", () => {
  const outcome = { day: "2026-10-29", coverage: 1, curtailedPossible: false, forecastSolarKwh: 8, actualSolarKwh: 7 };
  const result = energyLearning([outcome, outcome, { ...outcome, day: "2026-10-28", actualSolarKwh: NaN }], [], { now });
  assert.equal(result.forecastDays, 1);
  assert.equal(result.meanAbsoluteErrorKwh, 1);
});
