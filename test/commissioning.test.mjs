import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  commissioningAllowed,
  commissioningBinding,
} from "../src/commissioning-state.mjs";
import {
  Commissioning,
  commissioningRequirements,
} from "../src/commissioning.mjs";
import { emptyObservationProgress } from "../src/policy-observations.mjs";

const account = {
  id: randomUUID(),
  device_sn: "test-inverter",
  profile: "bluesun-bse20kh3",
  timezone: "Europe/Sofia",
};
const verification = {
  passed: true,
  firmware: { protocol: "2.02", dsp: "1.57", hmi: "1.45" },
};

test("commissioning permission binds approval to the current verified device and attended permission expires exactly", () => {
  const binding = commissioningBinding(account, verification);
  assert.match(binding, /^[a-f0-9]{64}$/);
  assert.equal(
    commissioningBinding(account, { ...verification, passed: false }),
    null,
  );
  assert.equal(
    commissioningBinding({ ...account, profile: "monitor-only" }, verification),
    null,
  );
  assert.notEqual(
    commissioningBinding({ ...account, timezone: "UTC" }, verification),
    binding,
  );
  const run = { binding, state: "approved" };
  assert.equal(commissioningAllowed(run, binding, "approved"), true);
  assert.equal(commissioningAllowed(run, null, "approved"), false);
  assert.equal(commissioningAllowed(run, "b".repeat(64), "approved"), false);
  assert.equal(commissioningAllowed(run, binding, "attended"), false);
  const now = Date.parse("2026-10-28T20:00:00Z");
  const attended = {
    ...run,
    state: "attending",
    attended_until: new Date(now + 1),
  };
  assert.equal(commissioningAllowed(attended, binding, "attended", now), true);
  assert.equal(
    commissioningAllowed(attended, binding, "attended", now + 1),
    false,
  );
  assert.equal(commissioningAllowed(attended, binding, "approved", now), false);
  for (const until of [null, "invalid", new Date(now - 1)])
    assert.equal(
      commissioningAllowed(
        { ...attended, attended_until: until },
        binding,
        "attended",
        now,
      ),
      false,
    );
});

test("settings and complete observation signals cannot manufacture verified independent power limits", () => {
  assert.equal(
    commissioningRequirements(null).every((r) => !r.passed),
    true,
  );
  const p = emptyObservationProgress();
  const firstAt = "2026-10-27T19:00:00Z";
  const lastAt = "2026-10-28T20:00:00Z";
  p.firstAt = firstAt;
  p.last = { at: lastAt };
  p.coveredSeconds = 90000;
  p.solarSeen = true;
  p.nightSeen = true;
  for (const key of ["solar", "discharge", "gridCharge", "gridStop"])
    p[key] = { count: 2, first: null, last: null, observedAt: lastAt };
  const requirements = commissioningRequirements({
    observation: { progress: p },
    recovery: { commandId: randomUUID() },
  });
  assert.deepEqual(
    requirements.filter((r) => !r.passed).map((r) => r.code),
    ["sourceLimits"],
  );
  assert.throws(
    () => commissioningRequirements({ observation: { progress: {} } }),
    /Invalid saved observation/,
  );
});

test("commissioning labels and control errors are translated in both languages", () => {
  const source = readFileSync(
    new URL("../web/commissioning.tsx", import.meta.url),
    "utf8",
  );
  const labels = source.slice(
    source.indexOf("const requirements"),
    source.indexOf("export default function"),
  );
  const keys = [...labels.matchAll(/:\s*("(?:[^"\\]|\\.)*")/g)].map((match) =>
    JSON.parse(match[1]),
  );
  keys.push(
    "An active attended commissioning session is required",
    "Inverter write requires current commissioning permission",
  );
  for (const language of ["en", "bg"]) {
    const catalogue = JSON.parse(
      readFileSync(
        new URL(`../web/locales/${language}.json`, import.meta.url),
        "utf8",
      ),
    );
    for (const key of keys) assert.ok(catalogue[key], key);
  }
});

test("starting commissioning expiry twice does not create competing workers and shutdown waits for the active pass", async () => {
  const service = new Commissioning({}, {});
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let calls = 0;
  service.expire = async () => {
    calls++;
    await gate;
    return 0;
  };
  service.start();
  service.start();
  assert.equal(calls, 1);
  let stopped = false;
  const stop = service.stop().then(() => {
    stopped = true;
  });
  await Promise.resolve();
  assert.equal(stopped, false);
  release();
  await stop;
  assert.equal(stopped, true);
  assert.equal(service.timer, null);
});
