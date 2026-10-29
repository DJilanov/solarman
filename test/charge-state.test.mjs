import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";

const source = readFileSync(
  new URL("../web/charge-state.ts", import.meta.url),
  "utf8",
);
const outputText = stripTypeScriptTypes(source);
const { chargeState, readingIsStale } = await import(
  `data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`
);
const now = Date.parse("2026-10-29T14:00:00Z");
const controller = {
  apiConfigured: true,
  deviceSelected: true,
  profile: "bluesun-bse20kh3",
  writesEnabled: true,
  manualTopup: false,
  recoveryTesting: false,
  pollSeconds: 360,
  telemetry: { deviceState: 1 },
  policy: { reserveSoc: 50 },
  control: { canStart: true, recovery: { pending: false, inFlight: false } },
};
const reading = { at: new Date(now - 60_000).toISOString(), soc: 30 };

test("a fresh reading below reserve still requires both backend control permissions", () => {
  assert.equal(chargeState(controller, reading, false, now), "ready");
  assert.equal(
    chargeState({ ...controller, writesEnabled: false }, reading, false, now),
    "setup",
  );
  assert.equal(
    chargeState(
      { ...controller, control: { ...controller.control, canStart: false } },
      reading,
      false,
      now,
    ),
    "setup",
  );
  assert.equal(chargeState(controller, reading, true, now), "busy");
});

test("missing, invalid, overdue, future and offline readings cannot permit charging", () => {
  for (const candidate of [
    null,
    { ...reading, at: "invalid" },
    { ...reading, at: new Date(now - 541_000).toISOString() },
    { ...reading, at: new Date(now + 61_000).toISOString() },
  ]) {
    assert.equal(readingIsStale(controller, candidate, now), true);
    assert.notEqual(chargeState(controller, candidate, false, now), "ready");
  }
  assert.equal(
    chargeState(
      { ...controller, telemetry: { deviceState: 0 } },
      reading,
      false,
      now,
    ),
    "stale",
  );
  assert.equal(
    readingIsStale({ ...controller, telemetry: null }, reading, now),
    false,
  );
});

test("the policy target, profile and connection are checked without assuming every tenant can charge", () => {
  assert.equal(
    chargeState(controller, { ...reading, soc: 50 }, false, now),
    "satisfied",
  );
  assert.equal(
    chargeState(controller, { ...reading, soc: 90 }, false, now),
    "satisfied",
  );
  assert.equal(
    chargeState(
      { ...controller, policy: { reserveSoc: 40 } },
      { ...reading, soc: 45 },
      false,
      now,
    ),
    "satisfied",
  );
  assert.equal(
    chargeState(
      { ...controller, profile: "monitoring-only" },
      reading,
      false,
      now,
    ),
    "unsupported",
  );
  assert.equal(
    chargeState({ ...controller, deviceSelected: false }, reading, false, now),
    "connection",
  );
});

test("recovery and ongoing writes take priority over an active manual request", () => {
  const active = { ...controller, manualTopup: true };
  assert.equal(chargeState(active, null, false, now), "active");
  assert.equal(
    chargeState({ ...active, recoveryTesting: true }, reading, false, now),
    "busy",
  );
  assert.equal(
    chargeState(
      {
        ...active,
        control: {
          ...active.control,
          recovery: { pending: false, inFlight: true },
        },
      },
      reading,
      false,
      now,
    ),
    "busy",
  );
  assert.equal(
    chargeState(
      {
        ...active,
        control: {
          ...active.control,
          recovery: { pending: true, inFlight: true },
        },
      },
      reading,
      false,
      now,
    ),
    "recovery",
  );
});
