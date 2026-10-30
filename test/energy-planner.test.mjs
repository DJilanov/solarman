import test from "node:test";
import assert from "node:assert/strict";
import {
  emptyEnergyProfile,
  validateEnergyProfile,
  missingEnergyInputs,
  fixedEnergyWindow,
  energySiteHash,
} from "../src/energy-profile.mjs";
import {
  energyLocalTime,
  energyTariff,
  energyNightWindows,
  energyIntervals,
  energyMinute,
} from "../src/energy-time.mjs";
import {
  energyMeasuredBuckets,
  learnEnergyDemand,
  predictEnergyDemand,
  calibrateEnergySolar,
  estimateBackupEndurance,
  suggestSurplusLoads,
} from "../src/energy-history.mjs";
import { chooseEnergyPlan, simulateEnergyPlan } from "../src/energy-model.mjs";

function profile() {
  const value = emptyEnergyProfile();
  value.site = {
    latitude: 42.7,
    longitude: 23.3,
    inverterKw: 20,
    arrays: [
      {
        name: "Test roof",
        kwp: 10,
        tilt: 30,
        azimuth: 180,
        lossFraction: 0.14,
        geometryConfirmed: true,
      },
    ],
  };
  value.battery.capacityKwh = 20;
  value.battery.powerConfirmed = true;
  value.battery.pvChargeKw = 5;
  value.battery.dischargeKw = 5;
  value.tariff.dayPrice = 0.11;
  value.tariff.nightPrice = 0.055;
  value.tariff.cyclingCost = 0.005;
  value.planning.fallbackDailyKwh = 24;
  return value;
}
function forecasts(now, { solarKw = 0, loadKw = 1 } = {}) {
  const start = Math.floor((now - 86400000) / 3600000) * 3600000,
    end = now + 5 * 86400000,
    solar = [],
    demand = [];
  for (let at = start; at < end; at += 3600000) {
    const hour = Math.floor(energyLocalTime(at, "Europe/Sofia").minute / 60);
    const pv = hour >= 9 && hour < 16 ? solarKw : 0;
    solar.push({
      start: at,
      end: at + 3600000,
      expectedKw: pv,
      lowKw: pv * 0.75,
      highKw: pv * 1.25,
      temperatureC: 10,
    });
  }
  for (const interval of energyIntervals(now, now + 5 * 86400000))
    demand.push({
      ...interval,
      expectedKw: loadKw,
      lowKw: loadKw * 0.8,
      highKw: loadKw * 1.2,
    });
  return { solar, demand };
}
function row(at, patch = {}) {
  return {
    observed_at: new Date(at),
    sampling_seconds: 300,
    pv_w: 0,
    load_w: 1000,
    grid_w: 1000,
    battery_w: 0,
    soc: 60,
    ...patch,
  };
}

test("energy profile preserves unknown inputs and strictly bounds setup fields", () => {
  const draft = emptyEnergyProfile();
  assert.deepEqual(validateEnergyProfile(draft), draft);
  assert.deepEqual(missingEnergyInputs(draft), [
    "location",
    "inverter",
    "panels",
    "battery",
    "prices",
  ]);
  const value = profile();
  assert.deepEqual(missingEnergyInputs(validateEnergyProfile(value)), []);
  for (const modify of [
    (v) => (v.site.latitude = "42.7"),
    (v) => (v.battery.capacityKwh = -20),
    (v) => (v.tariff.dayPrice = -1),
    (v) => (v.battery.reserveSoc = 101),
    (v) => (v.planning.maximumSoc = 49),
    (v) => (v.site.arrays[0].azimuth = 360),
    (v) => (v.unexpected = true),
    (v) => v.tariff.windows[0].months.push(4),
    (v) => (v.battery.chargeEfficiency = 1.1),
  ]) {
    const invalid = structuredClone(value);
    modify(invalid);
    assert.throws(() => validateEnergyProfile(invalid));
  }
  assert.equal(energyMinute("23:00"), 1380);
  assert.throws(() => energyMinute("24:00"));
  assert.throws(() => energyMinute("23:07"));
});

test("Bulgarian tariff months are independent of the daylight-saving transition", () => {
  const value = profile();
  assert.equal(
    energyTariff(value, Date.parse("2026-10-29T20:30:00Z")).night,
    false,
    "22:30 local is still daytime in October after DST ended",
  );
  assert.equal(
    energyTariff(value, Date.parse("2026-10-29T21:00:00Z")).night,
    true,
  );
  assert.equal(
    energyTariff(value, Date.parse("2026-11-02T20:00:00Z")).night,
    true,
  );
  assert.equal(
    energyTariff(value, Date.parse("2026-11-03T04:00:00Z")).night,
    false,
  );
  assert.equal(
    energyTariff(value, Date.parse("2026-04-01T19:30:00Z")).night,
    false,
  );
});

test("night windows preserve real duration through both clock changes", () => {
  const value = profile();
  const spring = energyNightWindows(
    value,
    Date.parse("2026-03-28T19:00:00Z"),
  )[0];
  const autumn = energyNightWindows(
    value,
    Date.parse("2026-10-24T18:00:00Z"),
  )[0];
  assert.equal((spring.end - spring.start) / 3600000, 7);
  assert.equal((autumn.end - autumn.start) / 3600000, 9);
  value.tariff.windows = fixedEnergyWindow("01:00", "05:00");
  assert.equal(
    energyNightWindows(value, Date.parse("2026-10-29T20:00:00Z"))[0].start,
    Date.parse("2026-10-29T23:00:00Z"),
  );
});

test("measurement integration excludes missing values and long gaps rather than manufacturing energy", () => {
  const start = Date.parse("2026-10-29T08:00Z");
  const bins = energyMeasuredBuckets([
    row(start),
    row(start + 300000),
    row(start + 3600000),
  ]);
  assert.equal(bins.length, 1);
  assert.equal(bins[0].coveredSeconds, 300);
  assert.ok(Math.abs(bins[0].loadKwh - 1 / 12) < 1e-10);
  assert.equal(
    energyMeasuredBuckets([row(start, { load_w: null }), row(start + 300000)])
      .length,
    0,
  );
  const crossing = energyMeasuredBuckets([
    row(start, { grid_w: 1000 }),
    row(start + 300000, { grid_w: -1000 }),
  ]);
  assert.ok(Math.abs(crossing[0].importKwh - 1 / 48) < 1e-10);
  assert.ok(Math.abs(crossing[0].exportKwh - 1 / 48) < 1e-10);
});

test("household learning exposes limited history and uses explicit fallback for missing hours", () => {
  const value = profile(),
    now = Date.parse("2026-10-29T20:00Z");
  const empty = learnEnergyDemand([], value, now);
  assert.equal(empty.ready, true);
  assert.equal(empty.quality, "limited");
  assert.equal(empty.observations[0].kw, 1);
  const missing = structuredClone(value);
  missing.planning.fallbackDailyKwh = null;
  assert.equal(learnEnergyDemand([], missing, now).ready, false);
  const rows = Array.from({ length: 289 }, (_, index) =>
    row(now - 86400000 + index * 300000),
  );
  const model = learnEnergyDemand(rows, missing, now);
  assert.equal(model.ready, true);
  assert.equal(model.quality, "limited");
  const forecast = forecasts(now);
  const demand = predictEnergyDemand(
    model,
    missing,
    forecast.solar,
    now,
    now + 86400000,
  );
  assert.equal(demand.length, 96);
  assert.ok(demand.every((slot) => Math.abs(slot.expectedKw - 1) < 1e-9));
});

test("battery simulation conserves energy and honors reserve, power and efficiency limits", () => {
  const value = profile(),
    now = Date.parse("2026-10-29T08:00Z"),
    f = forecasts(now, { loadKw: 10 });
  const result = simulateEnergyPlan(value, f.solar, f.demand, {
    from: now,
    to: now + 3600000,
    soc: 60,
  });
  assert.ok(Math.abs(result.importKwh - (10 - 2 * 0.95)) < 1e-9);
  assert.ok(Math.abs(result.finalSoc - 50) < 1e-9);
  assert.ok(result.timeline.every((slot) => slot.soc >= 50 - 1e-9));
  const small = simulateEnergyPlan(value, f.solar, f.demand, {
    from: now,
    to: now + 15 * 60000,
    soc: 100,
  });
  assert.ok(
    Math.abs(small.importKwh - 1.25) < 1e-9,
    "5 kW discharge cannot cover 10 kW load",
  );
});

test("reserve restart band preserves running discharge but does not spend an idle near-reserve charge", () => {
  const value = profile(),
    now = Date.parse("2026-10-29T08:00Z"),
    f = forecasts(now, { loadKw: 2 });
  const idle = simulateEnergyPlan(value, f.solar, f.demand, {
    from: now,
    to: now + 3600000,
    soc: 53,
  });
  assert.equal(idle.finalSoc, 53);
  assert.equal(idle.importKwh, 2);
  assert.ok(idle.timeline.every((slot) => slot.batteryDischargeKwh === 0));
  const running = simulateEnergyPlan(value, f.solar, f.demand, {
    from: now,
    to: now + 3600000,
    soc: 53,
    initialDischarging: true,
  });
  assert.ok(Math.abs(running.finalSoc - 50) < 1e-9);
  assert.ok(Math.abs(running.importKwh - 1.43) < 1e-9);
  assert.throws(
    () => simulateEnergyPlan(value, f.solar, f.demand, {
      from: now,
      to: now + 3600000,
      soc: 53,
      initialDischarging: "yes",
    }),
    /discharge state/,
  );
});

test("a reserve hold resets discharge until the conservative restart charge is available", () => {
  const value = profile(),
    now = Date.parse("2026-10-29T08:00Z"),
    f = forecasts(now, { loadKw: 1 });
  const result = simulateEnergyPlan(value, f.solar, f.demand, {
    from: now,
    to: now + 2 * 3600000,
    soc: 53,
    initialDischarging: true,
    night: { start: now, end: now + 3600000 },
    chargeStart: now,
    targetSoc: 53,
  });
  assert.equal(result.finalSoc, 53);
  assert.equal(result.importKwh, 2);
  assert.ok(result.timeline.every((slot) => slot.batteryDischargeKwh === 0));
});

test("solar enables discharge above the restart band and reaching reserve rearms the band", () => {
  const value = profile(),
    now = Date.parse("2026-10-29T08:00Z"),
    hour = 3600000;
  const phases = [
    [0, 1, 2, 0],
    [1, 2, 0, 2],
    [2, 2.25, 1, 0],
    [2.25, 2.5, 0, 1],
  ];
  const solar = phases.map(([start, end, pv]) => ({
    start: now + start * hour,
    end: now + end * hour,
    expectedKw: pv,
    lowKw: pv,
    highKw: pv,
  }));
  const demand = phases.map(([start, end, , load]) => ({
    start: now + start * hour,
    end: now + end * hour,
    expectedKw: load,
    highKw: load,
  }));
  const result = simulateEnergyPlan(value, solar, demand, {
    from: now,
    to: now + 2.5 * hour,
    soc: 50,
  });
  assert.ok(Math.abs(result.finalSoc - 51.1875) < 1e-9);
  assert.ok(Math.abs(result.importKwh - 0.445) < 1e-9);
  assert.ok(result.timeline
    .filter((slot) => slot.start >= now + 2.25 * hour)
    .every((slot) => slot.batteryDischargeKwh === 0));
});

test("battery model revisions retain the original identity of frozen solar forecasts", () => {
  const value = emptyEnergyProfile();
  value.site = {
    latitude: 42.7,
    longitude: 23.3,
    inverterKw: 20,
    arrays: [{
      name: "East roof",
      kwp: 10,
      tilt: 30,
      azimuth: 90,
      lossFraction: 0.14,
      geometryConfirmed: true,
    }],
  };
  assert.equal(
    energySiteHash(value),
    "bd150c2c50202a1c6d23f184ec176c102c65d2a6a8969b3a4b2fef2a32ab5cfa",
  );
});

test("the night planner finds a feasible cheaper target for a dark day and returns to daytime discharge", () => {
  const value = profile(),
    now = Date.parse("2026-11-02T18:00Z"),
    f = forecasts(now, { loadKw: 0.7 });
  const plan = chooseEnergyPlan({ profile: value, ...f, soc: 50, now });
  assert.equal(plan.action, "charge-and-hold");
  assert.ok(plan.targetSoc > 50 && plan.targetSoc <= 100);
  assert.ok(plan.estimatedSavings > 0);
  assert.ok(plan.conservativeSavings > 0);
  assert.ok(plan.selected.endNightSoc >= plan.targetSoc - 0.25);
  assert.ok(
    plan.selected.timeline.some(
      (slot) => !slot.night && slot.batteryDischargeKwh > 0,
    ),
  );
  assert.ok(
    plan.selected.timeline
      .filter(
        (slot) =>
          slot.start >= plan.night.start && slot.end <= plan.night.releaseAt,
      )
      .every((slot) => slot.batteryDischargeKwh === 0),
  );
  assert.ok(plan.chargeEnd < plan.night.end);
  assert.equal(plan.maximumChargeKw, 2);
});

test("an expensive night price and excessive cycling cost never justify nightly top-ups", () => {
  const now = Date.parse("2026-11-02T18:00Z"),
    f = forecasts(now, { loadKw: 0.5 });
  const expensive = profile();
  expensive.tariff.nightPrice = 0.55;
  const a = chooseEnergyPlan({ profile: expensive, ...f, soc: 50, now });
  assert.equal(a.action, "normal");
  assert.equal(a.estimatedSavings, 0);
  assert.ok(a.reasons.includes("night-not-cheaper"));
  const wear = profile();
  wear.tariff.cyclingCost = 1;
  const b = chooseEnergyPlan({ profile: wear, ...f, soc: 50, now });
  assert.equal(b.action, "normal");
});

test("abundant solar leaves battery headroom and cannot cover an earlier morning deficit retroactively", () => {
  const value = profile(),
    now = Date.parse("2026-11-02T18:00Z"),
    f = forecasts(now, { loadKw: 0.3, solarKw: 5 });
  const plan = chooseEnergyPlan({ profile: value, ...f, soc: 70, now });
  assert.ok(plan.targetSoc < 100);
  assert.ok(plan.selected.timeline.some((slot) => slot.solarChargeKwh > 0));
  const morning = forecasts(now, { loadKw: 0.2, solarKw: 5 });
  for (const slot of morning.demand) {
    const hour = energyLocalTime(slot.start, value.timezone).minute / 60;
    if (hour >= 6 && hour < 9) slot.expectedKw = slot.highKw = 2;
  }
  const second = chooseEnergyPlan({ profile: value, ...morning, soc: 50, now });
  assert.equal(second.action, "charge-and-hold");
  assert.ok(
    second.selected.timeline.some(
      (slot) =>
        energyLocalTime(slot.start, value.timezone).minute / 60 < 9 &&
        slot.batteryDischargeKwh > 0,
    ),
  );
});

test("insufficient time is reflected in achievable targets instead of promising a full battery", () => {
  const value = profile(),
    now = Date.parse("2026-11-03T03:30Z"),
    f = forecasts(now, { loadKw: 1 });
  const plan = chooseEnergyPlan({ profile: value, ...f, soc: 50, now });
  assert.ok(plan.targetSoc < 55);
  assert.throws(
    () =>
      chooseEnergyPlan({
        profile: value,
        solar: [],
        demand: f.demand,
        soc: 50,
        now,
      }),
    /complete planning horizon/,
  );
});

test("solar calibration ignores curtailment, incomplete days and hindsight", () => {
  const now = Date.parse("2026-11-30T12:00Z"),
    make = (index, patch = {}) => ({
      id: index,
      coverage: 1,
      rawSolarKwh: 10,
      actualSolarKwh: 8,
      forecastAt: "2026-10-29T12:00Z",
      dayStart: new Date(
        Date.parse("2026-10-30T00:00Z") + index * 86400000,
      ).toISOString(),
      assessedAt: "2026-11-10T00:00Z",
      ...patch,
    });
  const cold = calibrateEnergySolar([], 0.25, now);
  assert.equal(cold.source, "configured-scenarios");
  assert.equal(cold.lowScale, 0.75);
  const bad = [
    make(1, { coverage: 0.1 }),
    make(2, { curtailedPossible: true }),
    make(3, { forecastAt: "2026-11-30T00:00Z" }),
    make(4, { assessedAt: "2027-01-01T00:00Z" }),
  ];
  assert.equal(calibrateEnergySolar(bad, 0.25, now).days, 0);
  const learned = calibrateEnergySolar(
    Array.from({ length: 7 }, (_, index) => make(index)),
    0.25,
    now,
  );
  assert.equal(learned.source, "observed-error-range");
  assert.equal(learned.scale, 0.8);
});

test("endurance estimates use protected capacity and expose household versus essential load assumptions", () => {
  const value = profile(),
    now = Date.parse("2026-10-29T20:00Z"),
    reading = { soc: 60, at: new Date(now).toISOString() };
  const rows = [
    row(now - 300000, { load_w: 2000 }),
    row(now, { load_w: 2000 }),
  ];
  const result = estimateBackupEndurance(value, reading, rows, now, 20);
  assert.equal(result.floorSoc, 20);
  assert.ok(Math.abs(result.hours - 3.8) < 1e-9);
  assert.equal(result.loadSource, "recent-household-load");
  value.battery.essentialLoadW = 500;
  assert.equal(
    estimateBackupEndurance(value, reading, rows, now, 20).hours,
    15.2,
  );
  assert.equal(
    estimateBackupEndurance(
      value,
      { ...reading, at: new Date(now - 3600000).toISOString() },
      rows,
      now,
    ),
    null,
  );
});

test("surplus suggestions require a complete contiguous interval of sufficient available power", () => {
  const now = Date.parse("2026-10-29T10:00Z"),
    timeline = energyIntervals(now, now + 2 * 3600000).map((slot) => ({
      ...slot,
      surplusKw: 3,
    }));
  const loads = [
    { name: "Test flexible load", powerKw: 2, durationMinutes: 60 },
  ];
  assert.ok(suggestSurplusLoads(timeline, loads)[0].slot);
  timeline[2].surplusKw = 0;
  timeline[6].surplusKw = 0;
  assert.equal(suggestSurplusLoads(timeline, loads)[0].slot, null);
});

test("manual energy targets remain explicit even when the chosen top-up costs more", () => {
  const value = profile();
  value.tariff.nightPrice = 0.55;
  const now = Date.parse("2026-10-29T18:00Z"),
    data = forecasts(now);
  const plan = chooseEnergyPlan({
    profile: value,
    ...data,
    soc: 50,
    now,
    targetOverride: 80,
  });
  assert.equal(plan.targetSoc, 80);
  assert.equal(plan.action, "charge-and-hold");
  assert.ok(plan.estimatedSavings < 0);
  assert.ok(plan.reasons.includes("manual-target"));
  assert.throws(() =>
    chooseEnergyPlan({
      profile: value,
      ...data,
      soc: 50,
      now,
      targetOverride: 101,
    }),
  );
});

test("solar calibration counts distinct completed days rather than repeated forecasts of one day", () => {
  const now = Date.parse("2026-10-29T18:00Z"),
    base = {
      coverage: 1,
      curtailedPossible: false,
      rawSolarKwh: 10,
      actualSolarKwh: 12,
      assessedAt: "2026-10-28T22:00Z",
      forecastAt: "2026-10-26T12:00Z",
      dayStart: "2026-10-27T22:00Z",
    };
  const result = calibrateEnergySolar(
    Array.from({ length: 20 }, () => ({ ...base })),
    0.25,
    now,
  );
  assert.equal(result.days, 1);
  assert.equal(result.source, "configured-scenarios");
  assert.equal(result.scale, 1);
});
