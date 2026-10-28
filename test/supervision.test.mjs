import test from "node:test";
import assert from "node:assert/strict";
import { Supervision } from "../src/supervision.mjs";
const now = Date.parse("2026-10-28T11:00:00Z");
const reading = { soc: 40, pvW: 500, loadW: 800, gridW: 2250, batteryW: -1945 };
const context = { owned: false, verified: true, now };
const create = () => new Supervision({ auditMs: 3600000, retryMs: 900000 });

test("cold starts, unverified settings and owned schedules require native checks", () => {
  const state = create();
  assert.equal(state.plan(reading, context).native, true);
  state.checked("native_charging", now);
  assert.equal(state.plan(reading, { ...context, owned: true }).native, true);
  assert.equal(
    state.plan(reading, { ...context, verified: false }).native,
    true,
  );
  assert.equal(state.plan(reading, { ...context, force: true }).native, true);
});

test("native charging and solar surplus avoid repeated native reads until the policy audit", () => {
  const state = create();
  state.checked("native_charging", now);
  assert.deepEqual(state.plan(reading, { ...context, now: now + 300000 }), {
    native: false,
    reason: "native_charging",
  });
  assert.equal(
    state.plan({ ...reading, soc: 70 }, context).reason,
    "reserve_reached",
  );
  assert.equal(
    state.plan({ ...reading, pvW: 3000, loadW: 500 }, context).reason,
    "solar_can_charge",
  );
  assert.equal(
    state.plan(reading, { ...context, now: now + 3600000 }).native,
    true,
  );
  assert.equal(
    state.status().nextAuditAt,
    new Date(now + 3600000).toISOString(),
  );
});

test("a waiting below-reserve assessment respects its retry interval", () => {
  const state = create();
  state.checked("grid_not_available", now);
  const stopped = { ...reading, batteryW: 0, gridW: 0 };
  assert.deepEqual(state.plan(stopped, { ...context, now: now + 300000 }), {
    native: false,
    reason: "grid_not_available",
  });
  assert.equal(
    state.plan(stopped, { ...context, now: now + 900000 }).native,
    true,
  );
});

test("only distinct new uploads establish a policy deviation and trigger one early audit", () => {
  const state = create();
  state.checked("reserve_reached", now);
  const idle = { soc: 80, pvW: 0, loadW: 1000, gridW: 1000, batteryW: 0 };
  state.observe(idle, new Date(now + 1000));
  assert.equal(state.issue, null);
  state.observe(idle, new Date(now + 1000));
  assert.equal(state.issue, null);
  state.observe(idle, new Date(now + 2000));
  assert.equal(state.issue.code, "battery_not_supporting_home");
  assert.equal(state.plan(idle, { ...context, now: now + 2000 }).native, true);
  state.checked("reserve_reached", now + 2000);
  assert.equal(state.plan(idle, { ...context, now: now + 3000 }).native, false);
  state.observe({ ...idle, batteryW: 950, gridW: 50 }, new Date(now + 4000));
  assert.equal(state.issue, null);
  state.observe(idle, new Date(now + 3000));
  assert.equal(state.issue, null);
});

test("surplus without battery charging is flagged, while ordinary grid support and the reserve are allowed", () => {
  const state = create();
  for (const at of [1000, 2000])
    state.observe(
      { soc: 60, pvW: 2400, loadW: 1000, gridW: -1400, batteryW: 0 },
      new Date(now + at),
    );
  assert.equal(state.issue.code, "solar_not_charging");
  for (const reading of [
    { soc: 50, pvW: 0, loadW: 1000, gridW: 1000, batteryW: 0 },
    { soc: 80, pvW: 0, loadW: 5000, gridW: 1000, batteryW: 4000 },
    { soc: 80, pvW: 1100, loadW: 1000, gridW: -100, batteryW: 0 },
  ]) {
    const normal = create();
    normal.observe(reading, new Date(now + 1000));
    normal.observe(reading, new Date(now + 2000));
    assert.equal(normal.issue, null);
  }
});
