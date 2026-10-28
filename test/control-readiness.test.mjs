import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  CONTROL_REASONS,
  controlReadiness,
  supportedControlFirmware,
  matchingControlFirmware,
  CONTROL_FIRMWARE,
  verificationStatus,
} from "../src/control-readiness.mjs";
import { WorkQueue } from "../src/work-queue.mjs";

const ready = {
  connected: true,
  supported: true,
  serverAllowed: true,
  workspaceEnabled: true,
  commissioningApproved: true,
  verified: true,
  firmwareVerified: true,
  capacityAvailable: true,
  settingsMatch: true,
  clockVerified: true,
  clockFresh: true,
  cleanupVerified: true,
  stopping: false,
};

test("verification status distinguishes failure, binding, expiry and continuing activation", () => {
  const now = Date.parse("2026-10-28T18:00:00.000Z");
  const options = { current: true, activated: false, now };
  const report = {
    passed: true,
    checkedAt: new Date(now - 60_000).toISOString(),
  };
  assert.deepEqual(verificationStatus(null, options), {
    state: "missing",
    checkedAt: null,
    expiresAt: null,
  });
  assert.deepEqual(verificationStatus(report, options), {
    state: "verified",
    checkedAt: report.checkedAt,
    expiresAt: "2026-10-28T18:29:00.000Z",
  });
  assert.equal(
    verificationStatus({ ...report, passed: false }, options).state,
    "failed",
  );
  assert.equal(
    verificationStatus(report, { ...options, current: false }).state,
    "outdated",
  );
  const atBoundary = {
    ...report,
    checkedAt: new Date(now - 1800_000).toISOString(),
  };
  assert.equal(verificationStatus(atBoundary, options).state, "verified");
  const old = { ...report, checkedAt: new Date(now - 1800_001).toISOString() };
  assert.equal(verificationStatus(old, options).state, "expired");
  assert.deepEqual(verificationStatus(old, { ...options, activated: true }), {
    state: "verified",
    checkedAt: old.checkedAt,
    expiresAt: null,
  });
  assert.equal(
    verificationStatus(
      { ...old, passed: false },
      { ...options, activated: true },
    ).state,
    "failed",
  );
});

test("malformed and future verification timestamps never authorize activation", () => {
  const now = Date.parse("2026-10-28T18:00:00.000Z");
  for (const activated of [false, true]) {
    for (const checkedAt of ["invalid", "", new Date(now + 1).toISOString()]) {
      const status = verificationStatus(
        { passed: true, checkedAt },
        { current: true, activated, now },
      );
      assert.equal(status.state, "outdated");
      assert.equal(status.expiresAt, null);
    }
  }
});

test("each control requirement independently blocks starts without blocking a stop", () => {
  assert.equal(controlReadiness(ready).canStart, true);
  for (const key of [
    "serverAllowed",
    "tenantActive",
    "workspaceEnabled",
    "commissioningApproved",
    "verified",
    "firmwareVerified",
    "capacityAvailable",
    "settingsMatch",
    "clockVerified",
    "clockFresh",
    "cleanupVerified",
  ]) {
    const status = controlReadiness({ ...ready, [key]: false });
    assert.equal(status.canStart, false, key);
    assert.equal(status.canStop, true, key);
  }
  assert.equal(
    controlReadiness({ ...ready, serverAllowed: false }).canVerify,
    true,
  );
  assert.equal(
    controlReadiness({ ...ready, supported: false }).canVerify,
    false,
  );
  assert.equal(controlReadiness({ ...ready, stopping: true }).canStart, false);
});

test("only the diagnosed complete firmware identity supports control", () => {
  assert.equal(supportedControlFirmware({ ...CONTROL_FIRMWARE }), true);
  assert.equal(
    matchingControlFirmware(CONTROL_FIRMWARE, { ...CONTROL_FIRMWARE }),
    true,
  );
  for (const value of [
    null,
    {},
    { ...CONTROL_FIRMWARE, dsp: null },
    { ...CONTROL_FIRMWARE, hmi: "1.46" },
    { ...CONTROL_FIRMWARE, dsp: "1.570" },
  ]) {
    assert.equal(supportedControlFirmware(value), false);
    assert.equal(matchingControlFirmware(CONTROL_FIRMWARE, value), false);
  }
});

test("all readiness reasons have English and Bulgarian translations", () => {
  for (const lang of ["en", "bg"]) {
    const catalogue = JSON.parse(
      readFileSync(new URL(`../web/locales/${lang}.json`, import.meta.url)),
    );
    for (const message of Object.values(CONTROL_REASONS))
      assert.ok(catalogue[message], message);
  }
});

test("a stop jumps ahead of queued work while the active operation completes once", async () => {
  const queue = new WorkQueue();
  const order = [];
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const first = queue.enqueue(async () => {
    order.push("active");
    await gate;
  });
  const next = queue.enqueue(async () => {
    order.push("refresh");
  });
  const stop = queue.enqueue(async () => {
    order.push("stop");
  }, 10);
  let idle = false;
  const finished = queue.idle().then(() => {
    idle = true;
  });
  await Promise.resolve();
  assert.equal(idle, false);
  release();
  await Promise.all([first, next, stop, finished]);
  assert.deepEqual(order, ["active", "stop", "refresh"]);
  assert.equal(idle, true);
});

test("a failed operation does not strand the queue or its idle waiters", async () => {
  const queue = new WorkQueue();
  const failed = queue.enqueue(async () => {
    throw new Error("provider unavailable");
  });
  const success = queue.enqueue(async () => "next operation");
  await assert.rejects(failed, /provider unavailable/);
  assert.equal(await success, "next operation");
  await queue.idle();
});

test("a closing workspace cannot activate control even with otherwise passing evidence", () => {
  const status = controlReadiness({ ...ready, tenantClosing: true });
  assert.equal(status.canStart, false);
  assert.equal(status.canEnable, false);
  assert.equal(status.canVerify, true);
  assert.equal(status.canStop, true);
  assert.ok(status.reasons.some((reason) => reason.code === "closing"));
});
