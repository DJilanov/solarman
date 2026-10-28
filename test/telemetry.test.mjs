import test from "node:test";
import assert from "node:assert/strict";
import {
  parseProviderReading,
  normalizeBluesun,
  checkInverterClock,
} from "../src/telemetry.mjs";
import { providerPayload } from "./fixtures/provider.mjs";

const collectedAt = Date.parse("2026-10-28T09:59:52Z");
const now = collectedAt + 88_000;
const payload = (options = {}) => providerPayload({ collectedAt, ...options });
const reading = (body = payload(), at = now) =>
  parseProviderReading(body, "TEST-BLUESUN", at);

test("the verified Bluesun fields preserve source time, units and power directions", () => {
  const data = reading(payload({ values: { SYSTIM1: "2026-10-28 12:00:47" } }));
  const result = normalizeBluesun(data, "Europe/Sofia", now);
  assert.equal(data.collectedAt.getTime(), collectedAt);
  assert.deepEqual(result.snapshot, {
    soc: 45,
    pvW: 494,
    loadW: 304,
    gridW: 1779,
    batteryW: -1945,
    temperatureC: 16,
  });
  assert.equal(result.clock.skewSeconds, 55);
  assert.equal(result.clock.passed, true);
  assert.equal(result.versions.protocol, "2.02");
});

test("only readings for the selected inverter are accepted", () => {
  assert.throws(
    () => reading({ ...payload(), deviceSn: "OTHER-INVERTER" }),
    /selected inverter/,
  );
  assert.throws(
    () => reading({ ...payload(), deviceType: "COLLECTOR" }),
    /selected inverter/,
  );
  assert.throws(
    () => reading({ ...payload(), collectionTime: (now + 31_000) / 1000 }),
    /timestamp/,
  );
  assert.throws(
    () => reading({ ...payload(), dataList: Array(2001).fill({}) }),
    /format/,
  );
  const duplicate = payload();
  duplicate.dataList.push(duplicate.dataList[6]);
  assert.throws(() => reading(duplicate), /duplicate/);
});

test("credential-like provider fields are not retained for display", () => {
  const body = payload();
  body.dataList.push({
    key: "LCD_PASSWORD",
    name: "Device password",
    value: "fixture-private-value",
    unit: null,
  });
  assert.equal(
    reading(body).points.some((point) => point.key === "LCD_PASSWORD"),
    false,
  );
});

test("unknown models, protocol revisions and unit changes cannot silently change the mapping", () => {
  for (const values of [
    { MMN: "ANOTHER-INVERTER" },
    { PTCv1: "2.03" },
    { Pr1: "30000" },
  ])
    assert.throws(
      () => normalizeBluesun(reading(payload({ values })), "Europe/Sofia", now),
      /mapping/,
    );
  const body = payload();
  body.dataList.find((point) => point.key === "PVTP").unit = "kW";
  assert.throws(
    () => normalizeBluesun(reading(body), "Europe/Sofia", now),
    /PVTP/,
  );
});

test("invalid metrics never become zero and export/discharge retain their signs", () => {
  for (const value of ["", "N/A", "101", "-1", "1.5"])
    assert.throws(
      () =>
        normalizeBluesun(
          reading(payload({ values: { B_left_cap1: value } })),
          "Europe/Sofia",
          now,
        ),
      /B_left_cap1/,
    );
  const result = normalizeBluesun(
    reading(
      payload({
        values: { PG_Pt1: "-2000", B_P1: "1000", B_T1: "0", PVTP: "0" },
      }),
    ),
    "Europe/Sofia",
    now,
  );
  assert.equal(result.snapshot.gridW, -2000);
  assert.equal(result.snapshot.batteryW, 1000);
  assert.equal(result.snapshot.temperatureC, 0);
  assert.equal(result.snapshot.pvW, 0);
});

test("offline, alarm and stale uploads cannot create fresh normalized samples", () => {
  for (const state of [2, 3])
    assert.throws(
      () => normalizeBluesun(reading(payload({ state })), "Europe/Sofia", now),
      /offline|alarm/,
    );
  assert.throws(
    () => normalizeBluesun(reading(), "Europe/Sofia", collectedAt + 600_001),
    /fresh/,
  );
});

test("clock checks detect timezone errors, invalid dates and missing clock values", () => {
  assert.equal(checkInverterClock(reading(), "UTC").passed, false);
  assert.equal(
    checkInverterClock(
      reading(payload({ values: { SYSTIM1: "2026-02-30 12:00:00" } })),
      "Europe/Sofia",
    ).skewSeconds,
    null,
  );
  assert.equal(
    checkInverterClock(
      reading(payload({ values: { SYSTIM1: "" } })),
      "Europe/Sofia",
    ).passed,
    false,
  );
  const summer = Date.parse("2026-06-20T10:00:00Z");
  const summerReading = parseProviderReading(
    providerPayload({
      collectedAt: summer,
      values: { SYSTIM1: "2026-06-20 13:00:55" },
    }),
    "TEST-BLUESUN",
    summer,
  );
  assert.equal(checkInverterClock(summerReading, "Europe/Sofia").passed, true);
});

test("firmware fields are normalized without preventing monitoring of unvalidated firmware", () => {
  for (const [raw, expected] of [
    [" 1.57 ", "1.57"],
    ["1.58", "1.58"],
    ["", null],
    ["N/A", null],
    ["<bad>", null],
  ]) {
    const result = normalizeBluesun(
      reading(payload({ values: { DSP_V_M: raw } })),
      "Europe/Sofia",
      now,
    );
    assert.equal(result.versions.dsp, expected);
    assert.equal(result.snapshot.soc, 45);
  }
});
