import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";

const source = readFileSync(
  new URL("../web/reading-freshness.ts", import.meta.url),
  "utf8",
);
const outputText = stripTypeScriptTypes(source);
const { readingIsStale } = await import(
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

test("missing, invalid, overdue, future and offline readings cannot permit charging", () => {
  for (const candidate of [
    null,
    { ...reading, at: "invalid" },
    { ...reading, at: new Date(now - 541_000).toISOString() },
    { ...reading, at: new Date(now + 61_000).toISOString() },
  ]) {
    assert.equal(readingIsStale(controller, candidate, now), true);
  }
  assert.equal(
    readingIsStale(
      { ...controller, telemetry: { deviceState: 0 } },
      reading,
      now,
    ),
    true,
  );
  assert.equal(
    readingIsStale({ ...controller, telemetry: null }, reading, now),
    false,
  );
});
