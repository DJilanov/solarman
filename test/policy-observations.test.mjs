import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  observationIdentity,
  observationBinding,
  emptyObservationProgress,
  advanceObservation,
  observationWindow,
} from "../src/policy-observations.mjs";

const started = "2026-10-26T08:00:00.000Z";
function reading(minutes, values = {}) {
  const at = new Date(Date.parse(started) + minutes * 60000).toISOString();
  return {
    id: String(minutes + 1),
    observed_at: at,
    received_at: new Date(Date.parse(at) + 1000).toISOString(),
    reading_source: "provider",
    sampling_seconds: 300,
    soc: 50,
    pv_w: 0,
    load_w: 1000,
    grid_w: 1100,
    battery_w: 0,
    ...values,
  };
}
function advance(previous, minutes, values = {}) {
  return advanceObservation(
    previous,
    reading(minutes, values),
    started,
    "Europe/Sofia",
  );
}

test("observation identity binds the exact account, device, mapping, timezone and supported firmware", () => {
  const input = {
    accountId: randomUUID(),
    device: "observation-inverter",
    profile: "bluesun-bse20kh3",
    timezone: "Europe/Sofia",
    firmware: { protocol: "2.02", dsp: "1.57", hmi: "1.45" },
  };
  const original = observationBinding(input);
  assert.match(original, /^[a-f0-9]{64}$/);
  assert.equal(
    observationBinding({
      ...input,
      firmware: { ...input.firmware, collectedAt: "ignored" },
    }),
    original,
  );
  for (const change of [
    { accountId: randomUUID() },
    { device: "other-inverter" },
    { timezone: "UTC" },
  ])
    assert.notEqual(observationBinding({ ...input, ...change }), original);
  for (const change of [
    { profile: "monitor-only" },
    { firmware: { ...input.firmware, dsp: "1.58" } },
    { timezone: "invalid/timezone" },
    { accountId: "not-an-account" },
  ])
    assert.equal(observationIdentity({ ...input, ...change }), null);
  assert.equal(observationBinding(null), null);
});

test("solar evidence needs distinct source times and a rising SOC above the grid target", () => {
  let state = emptyObservationProgress();
  state = advance(state, 0, {
    soc: 51,
    pv_w: 2500,
    load_w: 1000,
    battery_w: -1400,
    grid_w: 0,
  });
  state = advance(state, 0, {
    soc: 52,
    pv_w: 2500,
    load_w: 1000,
    battery_w: -1400,
    grid_w: 0,
  });
  assert.equal(state.solar.count, 1);
  assert.equal(state.rejected, 1);
  state = advance(state, 5, {
    soc: 51,
    pv_w: 2500,
    load_w: 1000,
    battery_w: -1400,
    grid_w: 0,
  });
  assert.equal(state.solar.observedAt, null);
  state = advance(state, 10, {
    soc: 52,
    pv_w: 2500,
    load_w: 1000,
    battery_w: -1400,
    grid_w: 0,
  });
  assert.equal(state.solar.observedAt, reading(10).observed_at);
  assert.equal(state.solar.first.soc, 51);
  assert.equal(state.solar.last.soc, 52);
  const original = structuredClone(state.solar);
  state = advance(state, 15, { soc: 52, pv_w: 0, battery_w: 0 });
  assert.deepEqual(state.solar, original);
});

test("battery support above reserve permits simultaneous household grid support", () => {
  let state = advance(emptyObservationProgress(), 0, {
    soc: 60,
    load_w: 3000,
    battery_w: 1000,
    grid_w: 2100,
  });
  state = advance(state, 5, {
    soc: 59,
    load_w: 3000,
    battery_w: 1000,
    grid_w: 2100,
  });
  assert.ok(state.discharge.observedAt);
  assert.equal(state.gridCharge.observedAt, null);
});

test("near-target grid charging and its 50 percent transition require their own consecutive observations", () => {
  let state = advance(emptyObservationProgress(), 0, {
    soc: 48,
    battery_w: -1940,
    grid_w: 3100,
  });
  state = advance(state, 5, { soc: 49, battery_w: -1940, grid_w: 3100 });
  assert.ok(state.gridCharge.observedAt);
  state = advance(state, 10);
  assert.equal(state.gridStop.observedAt, null);
  state = advance(state, 15);
  assert.ok(state.gridStop.observedAt);
  let unchanged = advance(emptyObservationProgress(), 0);
  unchanged = advance(unchanged, 5);
  assert.equal(unchanged.gridStop.observedAt, null);
});

test("a grid-stop candidate survives normal upload drift across consecutive readings", () => {
  let state = emptyObservationProgress();
  const readings = [
    { seconds: 0, soc: 49, battery_w: -1937, grid_w: 2271 },
    { seconds: 304, soc: 49, battery_w: -1931, grid_w: 2853 },
    { seconds: 606, soc: 50, battery_w: 0, grid_w: 1420 },
    { seconds: 909, soc: 50, battery_w: 0, grid_w: 1220 },
  ];
  for (const [index, { seconds, ...values }] of readings.entries()) {
    const at = new Date(
      Date.parse(started) + seconds * 1000,
    ).toISOString();
    state = advance(state, index * 5, {
      ...values,
      observed_at: at,
      received_at: new Date(Date.parse(at) + 1000).toISOString(),
    });
    if (index < 3) assert.equal(state.gridStop.observedAt, null);
  }
  assert.ok(state.gridCharge.observedAt);
  assert.equal(state.gridStop.observedAt, state.last.at);
  assert.equal(state.gridStop.count, 2);
  assert.equal(
    state.gridStop.first.at,
    new Date(Date.parse(started) + 606000).toISOString(),
  );
});

test("an interrupted grid-stop candidate cannot use an old approach to complete later", () => {
  for (const interruption of [
    { minutes: 21, values: {} },
    { minutes: 14, values: { pv_w: 1200 } },
    { minutes: 14, values: { battery_w: -300 } },
    { minutes: 14, values: { soc: 51 } },
  ]) {
    let state = advance(emptyObservationProgress(), 0, {
      soc: 48,
      battery_w: -1940,
      grid_w: 3100,
    });
    state = advance(state, 5, { soc: 49, battery_w: -1940, grid_w: 3100 });
    state = advance(state, 10);
    assert.equal(state.gridStop.count, 1);
    state = advance(state, interruption.minutes, interruption.values);
    state = advance(state, interruption.minutes + 5);
    state = advance(state, interruption.minutes + 10);
    assert.equal(state.gridStop.observedAt, null);
    assert.equal(state.gridStop.count, 0);
  }
});

test("gaps, mixed solar and continued charging cannot manufacture a grid-stop transition", () => {
  let state = advance(emptyObservationProgress(), 0, {
    soc: 48,
    battery_w: -1940,
    grid_w: 3100,
  });
  state = advance(state, 5, { soc: 49, battery_w: -1940, grid_w: 3100 });
  state = advance(state, 10, { pv_w: 1200, battery_w: -500 });
  state = advance(state, 15, { battery_w: -300 });
  assert.equal(state.gridStop.observedAt, null);
  state = advance(state, 60);
  state = advance(state, 65);
  assert.equal(state.gridStop.observedAt, null);
});

test("missing metrics and late uploads are rejected instead of becoming zero-power evidence", () => {
  for (const invalid of [
    { pv_w: null },
    { battery_w: NaN },
    { soc: 101 },
    { sampling_seconds: 0 },
    { reading_source: "unknown" },
    { received_at: "2026-10-26T08:30:00.000Z" },
  ]) {
    const state = advance(emptyObservationProgress(), 0, invalid);
    assert.equal(state.accepted, 0);
    assert.equal(state.rejected, 1);
    assert.equal(state.nightSeen, false);
  }
  const state = advanceObservation(
    emptyObservationProgress(),
    reading(0),
    "2026-10-26T08:00:01.000Z",
    "Europe/Sofia",
  );
  assert.equal(state.accepted, 0);
});

test("a full-cycle signal requires 24 hours, useful coverage, solar and night observations", () => {
  let state = emptyObservationProgress();
  for (let minute = 0; minute <= 1440; minute += 5) {
    const hour = new Date(Date.parse(started) + minute * 60000).getUTCHours();
    state = advance(state, minute, { pv_w: hour >= 7 && hour < 14 ? 1000 : 0 });
  }
  assert.deepEqual(observationWindow(state), {
    spanSeconds: 86400,
    coverage: 1,
    cycleObserved: true,
  });
  let sparse = emptyObservationProgress();
  for (let minute = 0; minute <= 1440; minute += 5) {
    if (minute > 300 && minute < 600) continue;
    sparse = advance(sparse, minute, { pv_w: minute < 300 ? 1000 : 0 });
  }
  assert.equal(observationWindow(sparse).cycleObserved, false);
  assert.equal(
    observationWindow({ ...state, nightSeen: false }).cycleObserved,
    false,
  );
  assert.equal(
    observationWindow({ ...state, solarSeen: false }).cycleObserved,
    false,
  );
  let half = emptyObservationProgress();
  for (let minute = 0; minute <= 1440; minute += 10)
    half = advance(half, minute, { pv_w: minute < 300 ? 1000 : 0 });
  assert.equal(observationWindow(half).coverage, 0.5);
  assert.equal(observationWindow(half).cycleObserved, false);
});
