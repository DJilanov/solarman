import test from "node:test";
import assert from "node:assert/strict";
import { TenantRuntime } from "../src/tenant-runtime.mjs";

function runtimeFixture() {
  const calls = [];
  const runtime = {
    enableEpoch: 7,
    inhibitStarts: false,
    paused: true,
    manualTopup: true,
    topupExpiresAt: new Date(),
    cleanupRequired: false,
    events: [],
    controller: {
      enableRecoveryTest: async () => ({ soc: 55, flags: 9 }),
      read: async () => [0, 9],
    },
    journal: {
      pending: false,
      owned: false,
      requestCleanup: async () => {
        calls.push("pause");
        runtime.journal.pending = true;
        runtime.journal.owned = true;
      },
    },
    clearScheduledPermission: async () => {
      calls.push("clear");
      runtime.journal.pending = false;
      runtime.journal.owned = false;
      return true;
    },
  };
  return { runtime, calls };
}

test("the attended recovery path attempts cleanup even when enable acknowledgment is lost", async () => {
  const { runtime, calls } = runtimeFixture();
  runtime.controller.enableRecoveryTest = async () => {
    throw new Error("enable outcome unknown");
  };
  await assert.rejects(
    TenantRuntime.prototype.testScheduledRecovery.call(runtime, 7),
    /enable outcome unknown/,
  );
  assert.deepEqual(calls, ["pause", "clear"]);
  assert.equal(runtime.manualTopup, false);
  assert.equal(runtime.paused, true);
  assert.equal(runtime.topupExpiresAt, null);
  assert.equal(runtime.inhibitStarts, true);
});

test("an unconfirmed disable cannot report recovery success or leave a charging request active", async () => {
  const { runtime, calls } = runtimeFixture();
  runtime.clearScheduledPermission = async () => {
    calls.push("clear");
    throw new Error("off readback unavailable");
  };
  await assert.rejects(
    TenantRuntime.prototype.testScheduledRecovery.call(runtime, 7),
    /off readback unavailable/,
  );
  assert.deepEqual(calls, ["pause", "clear"]);
  assert.equal(runtime.manualTopup, false);
  assert.equal(runtime.paused, true);
  assert.equal(runtime.cleanupRequired, true);
  assert.equal(runtime.journal.owned, true);
});

test("recovery requires the original flags after cleanup and retains concurrent cancellation", async () => {
  const changed = runtimeFixture();
  changed.runtime.controller.read = async () => [0, 13];
  await assert.rejects(
    TenantRuntime.prototype.testScheduledRecovery.call(changed.runtime, 7),
    /Original charging flags/,
  );
  const cancelled = runtimeFixture();
  cancelled.runtime.controller.enableRecoveryTest = async () => {
    cancelled.runtime.enableEpoch++;
    return { soc: 55, flags: 9 };
  };
  const result = await TenantRuntime.prototype.testScheduledRecovery.call(
    cancelled.runtime,
    7,
  );
  assert.equal(result.cancelled, true);
  assert.equal(cancelled.runtime.manualTopup, false);
});
