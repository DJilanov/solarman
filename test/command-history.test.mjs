import test from "node:test";
import assert from "node:assert/strict";
import { historyEvidence } from "../src/command-history.mjs";

test("absent and malformed command evidence stays unavailable", () => {
  for (const value of [
    null,
    undefined,
    [],
    "old record",
    { events: [null, 4] },
  ])
    assert.deepEqual(historyEvidence(value), {
      decision: null,
      verification: null,
      events: [],
    });
});

test("history preserves the final decision and its native readings without exposing arbitrary event payloads", () => {
  const result = historyEvidence({
    password: "must-stay-private",
    decision: { charge: false, reason: "midnight_boundary" },
    events: [
      {
        event: "decision",
        charge: true,
        reason: "below_reserve",
        soc: 40,
        gridW: 2400,
        batteryW: -1900,
        dryRun: false,
        acEnabled: false,
        token: "must-stay-private",
      },
      { event: "unknown", payload: "must-stay-private" },
      {
        event: "native_policy_check",
        reason: "topup_assessment",
        appSecret: "must-stay-private",
      },
      { event: "ac_charge_changed", enabled: false },
    ],
  });
  assert.equal(result.decision.charge, false);
  assert.equal(result.decision.reason, "midnight_boundary");
  assert.equal(result.decision.batteryW, -1900);
  assert.equal(result.decision.soc, 40);
  assert.equal(result.decision.pvW, null);
  assert.deepEqual(result.events, [
    { code: "native_policy_check", reason: "topup_assessment", enabled: null },
    { code: "ac_charge_changed", reason: null, enabled: false },
  ]);
  assert.equal(JSON.stringify(result).includes("must-stay-private"), false);
});

test("historical verification retains missing actual values and clock comparison semantics", () => {
  const report = {
    checkedAt: "2026-10-28T12:17:42Z",
    passed: false,
    checks: [
      {
        label: "Inverter clock difference",
        actual: null,
        expected: 120,
        unit: "s",
        comparison: "at_most",
        passed: false,
        privateField: "must-stay-private",
      },
      {
        label: "Inverter rating",
        actual: 20000,
        expected: 20000,
        unit: "W",
        passed: true,
      },
    ],
  };
  const result = historyEvidence({
    events: [{ event: "device_verification", report }],
  });
  assert.equal(result.verification.checkedAt, "2026-10-28T12:17:42.000Z");
  assert.equal(result.verification.checks[0].actual, null);
  assert.equal(result.verification.checks[0].comparison, "at_most");
  assert.equal(result.verification.passed, false);
  assert.equal(JSON.stringify(result).includes("must-stay-private"), false);
  report.checkedAt = "invalid";
  assert.equal(
    historyEvidence({ events: [{ event: "device_verification", report }] })
      .verification,
    null,
  );
});

test("invalid numeric and boolean evidence is never coerced into a confirmed assessment", () => {
  assert.equal(
    historyEvidence({ decision: { charge: "true", reason: "below_reserve" } })
      .decision,
    null,
  );
  const result = historyEvidence({
    decision: {
      charge: false,
      reason: "reserve_reached",
      soc: "50",
      gridW: Infinity,
      batteryW: NaN,
      dryRun: "false",
    },
  });
  assert.equal(result.decision.soc, null);
  assert.equal(result.decision.gridW, null);
  assert.equal(result.decision.batteryW, null);
  assert.equal(result.decision.dryRun, null);
});
