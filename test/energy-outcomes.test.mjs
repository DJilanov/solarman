import test from "node:test";
import assert from "node:assert/strict";
import { energyProfile } from "./fixtures/energy.mjs";
import {
  scoreEnergyForecast,
  scoreEnergyPlan,
} from "../src/energy-outcomes.mjs";
import { nightNativeWindows } from "../src/energy-native.mjs";
import { validateChargeWindows } from "../src/outage-policy.mjs";
import { calculateEnergyPlan } from "../src/energy-calculation.mjs";

test("forecast outcomes require a frozen forecast before the local day and disclose missing coverage", () => {
  const profile = energyProfile(),
    start = Date.parse("2026-10-27T22:00Z"),
    end = start + 86400000,
    slots = [];
  for (let at = start; at < end; at += 3600000)
    slots.push({ start: at, end: at + 3600000, rawKw: 1, expectedKw: 1 });
  const forecast = {
      fetched_at: new Date(start - 3600000),
      payload: { slots },
    },
    rows = [];
  for (let at = start; at <= end; at += 300000)
    rows.push({
      observed_at: new Date(at),
      soc: 60,
      pv_w: 1000,
      load_w: 1200,
      grid_w: 200,
      battery_w: 0,
      sampling_seconds: 300,
    });
  const outcome = scoreEnergyForecast(forecast, rows, profile, end + 1000);
  assert.equal(outcome.length, 1);
  assert.equal(outcome[0].coverage, 1);
  assert.ok(Math.abs(outcome[0].actualSolarKwh - 24) < 1e-8);
  assert.equal(outcome[0].forecastSolarKwh, 24);
  assert.deepEqual(
    scoreEnergyForecast(
      { ...forecast, fetched_at: new Date(start) },
      rows,
      profile,
      end + 1000,
    ),
    [],
  );
  assert.deepEqual(scoreEnergyForecast(forecast, rows, profile, end - 1), []);
  const gap = scoreEnergyForecast(
    forecast,
    rows.filter((row) => row.observed_at.getTime() < start + 3600000),
    profile,
    end + 1000,
  )[0];
  assert.ok(gap.coverage < 0.05);
  assert.ok(gap.actualSolarKwh < 1);
  const scored = scoreEnergyPlan(
    {
      profile,
      prediction: {
        horizon: { start, end },
        selected: { gridCost: 1 },
        baseline: { gridCost: 2 },
      },
    },
    rows.slice(0, 5),
  );
  assert.equal(scored.estimatedCounterfactualSavings, null);
});

test("native night windows cross midnight with bounded HHMM words and reject invalid spans", () => {
  const plan = {
    chargeStart: Date.parse("2026-10-29T21:15Z"),
    chargeEnd: Date.parse("2026-10-30T04:58Z"),
  };
  assert.deepEqual(
    nightNativeWindows(plan, "Europe/Sofia"),
    [0x170f, 0x173b, 1, 0x063a, 0, 0, 0, 0],
  );
  assert.deepEqual(
    nightNativeWindows(
      { ...plan, chargeStart: Date.parse("2026-10-30T01:00Z") },
      "Europe/Sofia",
    ),
    [0x0300, 0x063a, 0, 0, 0, 0, 0, 0],
  );
  assert.throws(() =>
    nightNativeWindows(
      { ...plan, chargeEnd: plan.chargeStart + 13 * 3600000 },
      "Europe/Sofia",
    ),
  );
  for (const windows of [
    [0, 0, 0, 0, 0, 0, 0, 0],
    [0x2300, 0x2400, 0, 0, 0, 0, 0, 0],
    [0x0100, 0x0500, 0x0200, 0x0400, 0, 0, 0, 0],
  ])
    assert.throws(() => validateChargeWindows(windows));
});

test("energy calculation workers can be cancelled without blocking the main event loop", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(calculateEnergyPlan({}, controller.signal), /cancelled/);
  const active = new AbortController(),
    work = calculateEnergyPlan({}, active.signal);
  active.abort();
  await assert.rejects(work, /cancelled/);
});

test("counterfactual savings compare only observed periods and include configured battery wear", () => {
  const profile = energyProfile();
  profile.tariff.dayPrice = 1;
  profile.tariff.nightPrice = 1;
  profile.tariff.cyclingCost = 0.1;
  const start = Date.parse("2026-10-29T12:00Z"),
    end = start + 3600000,
    rows = [];
  for (let minute = 5; minute <= 60; minute += 5)
    rows.push({
      observed_at: new Date(start + minute * 60000),
      soc: 80 - minute / 12,
      pv_w: 0,
      load_w: 2000,
      grid_w: 1000,
      battery_w: 1000,
      sampling_seconds: 300,
    });
  const timeline = Array.from({ length: 4 }, (_, index) => ({
    start: start + index * 900000,
    end: start + (index + 1) * 900000,
    cost: 0.5,
    cyclingCost: 0,
  }));
  const plan = {
    state: "completed",
    code: null,
    profile,
    prediction: {
      horizon: { start, end },
      selected: { gridCost: 0.9 },
      baseline: { gridCost: 2, totalCost: 2, timeline },
    },
  };
  const score = scoreEnergyPlan(plan, rows);
  assert.ok(Math.abs(score.coverage - 55 / 60) < 1e-8);
  assert.ok(Math.abs(score.estimatedCounterfactualSavings - 0.825) < 1e-8);
  assert.ok(score.observedCyclingCost > 0);
  assert.equal(
    scoreEnergyPlan({ ...plan, state: "cancelled" }, rows)
      .estimatedCounterfactualSavings,
    null,
  );
});

test("forecast assessment chooses the latest forecast made before the day and runs in a cancellable worker", async () => {
  const { scoreEnergyForecasts } = await import("../src/energy-outcomes.mjs");
  const { calculateEnergyOutcomes } =
    await import("../src/energy-calculation.mjs");
  const profile = energyProfile(),
    start = Date.parse("2026-10-27T22:00Z"),
    end = start + 86400000,
    slots = Array.from({ length: 24 }, (_, index) => ({
      start: start + index * 3600000,
      end: start + (index + 1) * 3600000,
      rawKw: 1,
      expectedKw: 1,
    })),
    rows = [];
  for (let at = start; at <= end; at += 300000)
    rows.push({
      observed_at: new Date(at),
      soc: 60,
      pv_w: 1000,
      load_w: 1200,
      grid_w: 200,
      battery_w: 0,
      sampling_seconds: 300,
    });
  const forecasts = [
    { id: "older", fetched_at: new Date(start - 7200000), payload: { slots } },
    { id: "latest", fetched_at: new Date(start - 3600000), payload: { slots } },
    {
      id: "hindsight",
      fetched_at: new Date(start + 60000),
      payload: { slots },
    },
  ];
  const input = { profile, forecasts, rows, now: end + 60000 };
  const expected = scoreEnergyForecasts(input);
  assert.equal(expected.length, 1);
  assert.equal(expected[0].forecastId, "latest");
  assert.ok(Math.abs(expected[0].outcome.rawCoveredSolarKwh - 24) < 1e-7);
  let ticks = 0;
  const timer = setInterval(() => ticks++, 1);
  try {
    assert.deepEqual(await calculateEnergyOutcomes(input), expected);
    assert.ok(ticks > 0);
  } finally {
    clearInterval(timer);
  }
});
