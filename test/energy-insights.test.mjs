import test from "node:test";
import assert from "node:assert/strict";
import { assessEnergyInsights } from "../src/energy-insights-model.mjs";
import { energyProfile, energyWeather } from "./fixtures/energy.mjs";

const now = Date.parse("2026-11-07T12:00:00Z");
function fixture() {
  const rows = [];
  for (let at = now - 21 * 86400000; at <= now; at += 300000) rows.push({ observed_at: new Date(at), load_w: at >= now - 2 * 3600000 ? 4000 : 1000, pv_w: 0, battery_w: 0, grid_w: 1000, soc: 60, sampling_seconds: 300 });
  const forecast = energyWeather(now - 3 * 3600000);
  forecast.slots.forEach(slot => { slot.lowKw = 2; slot.expectedKw = 3; });
  return { profile: energyProfile(), rows, forecasts: [{ fetched_at: new Date(now - 3 * 3600000), payload: forecast }], now };
}
test("energy observations require sustained high use and compare solar with a previously issued conservative forecast", () => {
  const result = assessEnergyInsights(fixture());
  assert.equal(result.consumption.state, "active");
  assert.equal(result.consumption.actualKw, 4);
  assert.equal(result.consumption.typicalKw, 1);
  assert.ok(result.consumption.referenceDays >= 3);
  assert.equal(result.solar.state, "active");
  assert.equal(result.solar.conservativeKwh, 4);
  assert.equal(result.solar.actualKwh, 0);
});
test("brief spikes, ordinary variation and low forecast production do not create energy advisories", () => {
  const input = fixture();
  input.rows.forEach(row => { row.load_w = 1000; });
  input.rows.at(-2).load_w = 4000;
  input.forecasts[0].payload.slots.forEach(slot => { slot.lowKw = 0.1; });
  const result = assessEnergyInsights(input);
  assert.equal(result.consumption.state, "healthy");
  assert.equal(result.solar.state, "unavailable");
});
test("missing, stale, offline and future data remain unavailable instead of being treated as zero", () => {
  const input = fixture();
  assert.equal(assessEnergyInsights({ ...input, rows: [] }).consumption.state, "stale");
  assert.equal(assessEnergyInsights({ ...input, online: false }).solar.state, "stale");
  assert.equal(assessEnergyInsights({ ...input, now: now + 11 * 60000 }).solar.state, "stale");
  assert.equal(assessEnergyInsights({ ...input, now: now - 60000 }).solar.state, "stale");
  const incomplete = input.rows.filter(row => row.observed_at.getTime() <= now - 50 * 60000 || row.observed_at.getTime() >= now - 10 * 60000);
  assert.equal(assessEnergyInsights({ ...input, rows: incomplete }).consumption.state, "unavailable");
  assert.equal(assessEnergyInsights({ ...input, rows: input.rows.slice(-30) }).consumption.state, "learning");
});
test("solar comparisons reject revised-after-the-fact weather and possible full-battery curtailment", () => {
  const input = fixture();
  assert.equal(assessEnergyInsights({ ...input, forecasts: [{ ...input.forecasts[0], fetched_at: new Date(now) }] }).solar.state, "unavailable");
  input.rows.at(-5).soc = 100;
  assert.equal(assessEnergyInsights(input).solar.state, "curtailment-possible");
});
test("Away measurements are not used to learn a falsely low normal baseline or flag an occupied comparison", () => {
  const input = fixture();
  assert.equal(assessEnergyInsights({ ...input, away: [{ start: now - 3600000, end: now + 3600000 }] }).consumption.state, "unavailable");
  assert.equal(assessEnergyInsights({ ...input, away: [{ start: now - 22 * 86400000, end: now - 86400000 }] }).consumption.state, "learning");
});
