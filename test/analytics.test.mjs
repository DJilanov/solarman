import test from "node:test";
import assert from "node:assert/strict";
import {
  positiveEnergy,
  summarize,
  dayStart,
  addDays,
  localDay,
} from "../src/analytics.mjs";

const start = Date.parse("2026-10-27T08:00:00Z");
function sample(at, overrides = {}) {
  return {
    observed_at: new Date(at),
    soc: 70,
    temperature_c: 19,
    pv_w: 1000,
    load_w: 500,
    grid_w: -100,
    battery_w: -300,
    ...overrides,
  };
}

test("sign changes are split at zero rather than overcounting charge and discharge", () => {
  assert.equal(positiveEnergy(1000, -1000, 1), 0.25);
  assert.equal(positiveEnergy(-1000, 1000, 1), 0.25);
  assert.equal(positiveEnergy(1000, 1000, 1), 1);
  assert.equal(positiveEnergy(-1000, -1000, 1), 0);
});

test("energy uses elapsed time, correct source signs, and excludes long gaps", () => {
  const rows = [
    sample(start),
    sample(start + 900_000),
    sample(start + 4_500_000),
  ];
  const result = summarize(rows, {
    start,
    end: start + 4_500_000,
    pollMs: 900_000,
  });
  assert.equal(result.totals.solarKwh, 0.25);
  assert.equal(result.totals.loadKwh, 0.125);
  assert.equal(result.totals.importKwh, 0);
  assert.equal(result.totals.exportKwh, 0.025);
  assert.equal(result.totals.chargeKwh, 0.075);
  assert.equal(result.totals.dischargeKwh, 0);
  assert.equal(result.coverage, 0.2);
  assert.equal(
    result.points.some((point) => point.pvW === null),
    true,
  );
});

test("empty and single-sample ranges do not manufacture zero energy totals", () => {
  for (const rows of [[], [sample(start)]]) {
    const result = summarize(rows, {
      start,
      end: start + 900_000,
      pollMs: 900_000,
    });
    assert.equal(result.totals, null);
    assert.equal(result.coverage, 0);
  }
});

test("local days honor both daylight-saving transitions", () => {
  assert.equal(
    (dayStart("2026-03-30") - dayStart("2026-03-29")) / 3600_000,
    23,
  );
  assert.equal(
    (dayStart("2026-10-26") - dayStart("2026-10-25")) / 3600_000,
    25,
  );
  assert.equal(localDay(Date.parse("2026-10-26T22:30:00Z")), "2026-10-27");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.throws(() => dayStart("2026-02-30"), /Invalid date/);
});

test("samples spanning local midnight are allocated to the correct days", () => {
  const midnight = dayStart("2026-10-27");
  const result = summarize(
    [sample(midnight - 900_000), sample(midnight + 900_000)],
    { start: midnight - 900_000, end: midnight + 900_000, pollMs: 900_000 },
  );
  assert.deepEqual(
    result.daily.map((day) => [day.day, day.solarKwh]),
    [
      ["2026-10-26", 0.25],
      ["2026-10-27", 0.25],
    ],
  );
});

test("CSV resolution retains every real sample and excludes chart-only gap markers", () => {
  const rows = Array.from({ length: 1001 }, (_, index) =>
    sample(start + index * 1000),
  );
  rows.push(sample(start + 10_000_000));
  const options = { start, end: start + 10_000_000, pollMs: 1000 };
  const chart = summarize(rows, options);
  const full = summarize(rows, { ...options, fullResolution: true });
  assert.ok(chart.points.length < rows.length);
  assert.equal(full.points.length, rows.length);
  assert.ok(full.points.every((point) => point.pvW !== null));
  assert.deepEqual(chart.totals, full.totals);
});

test("changing monitoring cadence preserves historical coverage and excludes later gaps", () => {
  const rows = [
    sample(start, { sampling_seconds: 900 }),
    sample(start + 900_000, { sampling_seconds: 900 }),
    sample(start + 1200_000, { sampling_seconds: 300 }),
    sample(start + 1500_000, { sampling_seconds: 300 }),
    sample(start + 2700_000, { sampling_seconds: 300 }),
  ];
  const options = { start, end: start + 2700_000 };
  const oldCadence = summarize(rows, { ...options, pollMs: 900_000 });
  const newCadence = summarize(rows, { ...options, pollMs: 300_000 });
  assert.deepEqual(oldCadence.totals, newCadence.totals);
  assert.equal(newCadence.totals.coveredSeconds, 1500);
  assert.equal(
    newCadence.points.filter((point) => point.pvW === null).length,
    1,
  );
});
