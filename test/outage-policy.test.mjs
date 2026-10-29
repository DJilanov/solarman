import test from "node:test";
import assert from "node:assert/strict";
import {
  OUTAGE_WINDOWS,
  allowedOutageWrite,
  normalSettingsMatch,
  observeOutageHold,
  outageBaseline,
  outageSettingsMatch,
  outageTarget,
  outageTestPassed,
} from "../src/outage-policy.mjs";
import { OutageNativeController } from "../src/outage-native.mjs";

function fixture() {
  const state = {
    flags: 9,
    mode: 0,
    acPowerRaw: 100,
    acTargetRaw: 500,
    windows: Array(8).fill(0),
    soc: 60,
    batteryState: 4,
    loadW: 1500,
    pvW: 0,
    gridW: 1500,
    batteryW: 0,
    gridVoltages: [230, 231, 229],
  };
  const settings = Array(32).fill(0);
  settings[0] = 1000;
  settings[1] = 100;
  settings[31] = 500;
  const writes = [];
  const inspector = {
    snapshot: async () => structuredClone(state),
    read: async (fn, address) =>
      address === 7
        ? [0, 20000]
        : address === 2500
          ? [state.mode]
          : address === 2505
            ? [state.acTargetRaw]
            : address === 2509
              ? [...state.windows]
              : address === 206
                ? [0, state.flags]
                : [...settings],
  };
  const native = new OutageNativeController(
    inspector,
    async (address, values, phase) => {
      writes.push({ address, values: [...values], phase });
      if (address === 2500) state.mode = values[0];
      else if (address === 2505) state.acTargetRaw = values[0];
      else if (address === 2509) state.windows = [...values];
      else if (address === 206) state.flags = values[0] * 65536 + values[1];
      else assert.fail("Unexpected hardware write");
    },
  );
  return { state, settings, writes, native };
}

test("outage targets are bounded whole percentages and do not accept coerced input", () => {
  for (const value of [50, 80, 90, 100])
    assert.equal(outageTarget(value), value);
  for (const value of [null, undefined, "80", 49, 101, 80.5, NaN, Infinity])
    assert.throws(() => outageTarget(value));
});

test("native outage preparation charges to the chosen AC target and preserves solar and battery protection settings", async () => {
  const f = fixture();
  const baseline = await f.native.baseline();
  await f.native.apply(baseline, 80);
  assert.equal(f.state.mode, 3);
  assert.equal(f.state.acTargetRaw, 800);
  assert.equal(f.state.flags, 25);
  assert.deepEqual(f.state.windows, OUTAGE_WINDOWS);
  assert.equal(f.settings[0], 1000);
  assert.equal(f.settings[1], 100);
  assert.equal(f.settings[31], 500);
  assert.deepEqual(
    f.writes.map((row) => row.address),
    [2500, 2505, 2509, 206],
  );
  assert.equal(outageSettingsMatch(f.state, f.settings, baseline, 80), true);
});

test("return to normal restores the captured settings and returns to SelfUse last", async () => {
  const f = fixture();
  const baseline = await f.native.baseline();
  await f.native.apply(baseline, 90);
  f.writes.length = 0;
  f.settings[5] = 42;
  await f.native.restore(baseline, 90);
  assert.deepEqual(
    f.writes.map((row) => row.address),
    [206, 2509, 2505, 2500],
  );
  assert.equal(normalSettingsMatch(f.state, f.settings, baseline), true);
  assert.equal(
    f.settings[5],
    42,
    "Unrelated battery settings are never overwritten",
  );
});

test("partially applied outage settings can be restored without enabling grid charging", async () => {
  const f = fixture();
  const baseline = await f.native.baseline();
  f.state.mode = 3;
  f.state.acTargetRaw = 800;
  await f.native.restore(baseline, 80);
  assert.equal(normalSettingsMatch(f.state, f.settings, baseline), true);
  assert.ok(f.writes.every((row) => row.address !== 206));
});

test("outage preparation refuses unverified baselines and restoration preserves outside changes", async () => {
  const f = fixture();
  const baseline = await f.native.baseline();
  for (const change of [
    { flags: 25 },
    { mode: 2 },
    { acPowerRaw: 200 },
    { acTargetRaw: 900 },
    { windows: [1, 6000, 0, 0, 0, 0, 0, 0] },
  ])
    assert.throws(() => outageBaseline({ ...f.state, ...change }, f.settings));
  f.state.mode = 2;
  await assert.rejects(f.native.restore(baseline, 80), /changed outside/);
  assert.equal(f.writes.length, 0);
  f.state.mode = 3;
  f.settings[1] = 200;
  await assert.rejects(f.native.restore(baseline, 80), /changed outside/);
  assert.equal(f.writes.length, 0);
});

test("outage write authorization allows only the exact chosen settings and captured restoration", async () => {
  const f = fixture();
  const baseline = await f.native.baseline();
  assert.equal(allowedOutageWrite(baseline, 80, "apply", 2505, [800]), true);
  assert.equal(allowedOutageWrite(baseline, 80, "apply", 2505, [1000]), false);
  assert.equal(allowedOutageWrite(baseline, 80, "restore", 2505, [500]), true);
  assert.equal(allowedOutageWrite(baseline, 80, "restore", 2505, [800]), false);
  for (const address of [2504, 3005, 3006, 3036, 208])
    assert.equal(
      allowedOutageWrite(baseline, 80, "apply", address, [1000]),
      false,
    );
});

test("hold evidence requires distinct, continuous readings above the normal reserve with real grid demand", () => {
  const { state } = fixture();
  const at = Date.parse("2026-10-29T15:00:00Z");
  let proof = observeOutageHold({}, state, at);
  assert.equal(proof.holdObservedAt, undefined);
  proof = observeOutageHold(proof, state, at);
  assert.equal(proof.holdObservedAt, undefined);
  proof = observeOutageHold(proof, state, at + 30_000);
  assert.ok(proof.holdObservedAt);
  for (const change of [
    { soc: 50 },
    { pvW: 1600 },
    { batteryW: 800 },
    { gridW: 0 },
    { gridVoltages: [0, 0, 0] },
  ]) {
    let candidate = observeOutageHold({}, { ...state, ...change }, at);
    candidate = observeOutageHold(
      candidate,
      { ...state, ...change },
      at + 60_000,
    );
    assert.equal(candidate.holdObservedAt, undefined);
  }
  let gap = observeOutageHold({}, state, at);
  gap = observeOutageHold(gap, state, at + 21 * 60_000);
  assert.equal(gap.holdObservedAt, undefined);
});

test("observed backup use remains separate from verified hold and restoration", () => {
  const { state } = fixture();
  const proof = observeOutageHold(
    {},
    { ...state, gridVoltages: [0, 0, 0], batteryW: 1500 },
    Date.now(),
  );
  assert.ok(proof.backupUseObservedAt);
  assert.equal(outageTestPassed(proof), false);
  const complete = {
    gridChargingObservedAt: "2026-10-29T15:00:30Z",
    targetHoldObservedAt: "2026-10-29T15:01:30Z",
    appliedAt: "2026-10-29T15:00:00Z",
    holdObservedAt: "2026-10-29T15:01:00Z",
    restoredAt: "2026-10-29T15:02:00Z",
    applyWritesVerified: true,
    restoreWritesVerified: true,
    backupSettingsPreserved: true,
  };
  assert.equal(outageTestPassed(complete), true);
  assert.equal(
    outageTestPassed({ ...complete, restoreWritesVerified: false }),
    false,
  );
});

test("native outage restoration defers during a grid outage without changing backup settings", async () => {
  const f = fixture();
  const baseline = await f.native.baseline();
  await f.native.apply(baseline, 80);
  f.writes.length = 0;
  f.state.gridVoltages = [0, 0, 0];
  await assert.rejects(f.native.restore(baseline, 80), /when the grid returns/);
  assert.equal(f.writes.length, 0);
  assert.equal(f.state.mode, 3);
});

test("outside changes between initial reads and apply are not overwritten", async () => {
  const f = fixture();
  const baseline = await f.native.baseline();
  f.state.acTargetRaw = 900;
  await assert.rejects(f.native.apply(baseline, 80), /changed before/);
  assert.ok(f.writes.every((write) => write.address !== 2505));
});

test("later on-grid discharge invalidates earlier hold evidence", () => {
  const { state } = fixture();
  const at = Date.now();
  const proof = observeOutageHold(
    { holdObservedAt: new Date(at - 60000).toISOString() },
    { ...state, batteryW: 900 },
    at,
  );
  assert.ok(proof.holdViolatedAt);
  assert.equal(outageTestPassed(proof), false);
});
