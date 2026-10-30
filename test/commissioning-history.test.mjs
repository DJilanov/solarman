import test from "node:test";
import assert from "node:assert/strict";
import { reviewHistoricalReadings } from "../src/commissioning-history.mjs";

const binding = "a".repeat(64), startedAt = "2026-10-26T08:00:00.000Z";
function row(minute, values = {}) {
  const at = new Date(Date.parse(startedAt) + minute * 60000);
  return {
    id: String(minute + 1), observed_at: at,
    received_at: new Date(at.getTime() + 1000), reading_source: "provider",
    sampling_seconds: 300, soc: 50, pv_w: 0, load_w: 1000,
    grid_w: 1100, battery_w: 0, control_binding: binding, ...values,
  };
}
function review(rows) {
  return reviewHistoricalReadings(rows, binding, startedAt, "Europe/Sofia");
}

test("historical review derives all five signals from real-format rows without counting excluded periods", () => {
  const rows = [];
  for (let minute = 0; minute <= 1440; minute += 5) {
    let values = {};
    if (minute < 10) values = { soc: 49, battery_w: -1930, grid_w: 3000 };
    if (minute === 20 || minute === 25)
      values = { soc: minute === 20 ? 53 : 54, pv_w: 2500, grid_w: 0, battery_w: -1400 };
    if (minute === 30 || minute === 35)
      values = { soc: minute === 30 ? 54 : 53, battery_w: 1000, grid_w: 0 };
    if (minute === 60) values = { control_binding: null };
    rows.push(row(minute, values));
  }
  const before = structuredClone(rows), result = review(rows);
  for (const code of ["solar", "discharge", "gridCharge", "gridStop"])
    assert.ok(result.progress[code].observedAt, code);
  assert.equal(result.progress.accepted, 288);
  assert.equal(result.excluded, 1);
  assert.ok(result.window.coverage < 1 && result.window.coverage > 0.9);
  assert.equal(result.window.cycleObserved, true);
  assert.deepEqual(rows, before);
  assert.equal(review(rows).hash, result.hash);
  rows[0].battery_w = -1940;
  assert.notEqual(review(rows).hash, result.hash);
});

test("historical review never bridges a missing binding to complete a charging or stop signal", () => {
  const result = review([
    row(0, { soc: 49, battery_w: -1930, grid_w: 3000 }),
    row(5, { control_binding: null }),
    row(10, { soc: 49, battery_w: -1930, grid_w: 3000 }),
    row(15), row(20),
  ]);
  assert.equal(result.progress.gridCharge.observedAt, null);
  assert.equal(result.progress.gridStop.observedAt, null);
  assert.equal(result.progress.coveredSeconds, 600);
});

test("a different known policy discards older signals even if the original binding returns", () => {
  const result = review([
    row(0, { soc: 49, battery_w: -1930, grid_w: 3000 }),
    row(5, { soc: 49, battery_w: -1930, grid_w: 3000 }),
    row(10), row(15),
    row(20, { control_binding: "b".repeat(64) }), row(25),
  ]);
  assert.equal(result.progress.gridCharge.observedAt, null);
  assert.equal(result.progress.gridStop.observedAt, null);
  assert.equal(result.progress.accepted, 1);
  assert.equal(result.window.cycleObserved, false);
});

test("late uploads and missing values remain rejected in historical reviews", () => {
  const result = review([
    row(0, { pv_w: null }),
    row(5, { received_at: new Date(Date.parse(startedAt) + 20 * 60000) }),
    row(10),
  ]);
  assert.equal(result.progress.accepted, 1);
  assert.equal(result.progress.rejected, 2);
  assert.equal(result.window.cycleObserved, false);
});
