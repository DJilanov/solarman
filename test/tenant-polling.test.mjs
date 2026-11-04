import test from "node:test";
import assert from "node:assert/strict";
import { TenantRuntime } from "../src/tenant-runtime.mjs";
import { SolarmanTransportError } from "../src/solarman.mjs";

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("only known communication failures without unresolved cleanup receive the notification grace period", async () => {
  const stale = "The provider has not supplied fresh device readings";
  const offline = "The inverter is offline or reporting an alarm";
  for (const [error, state, cleanupFails, pending, expected] of [
    [new SolarmanTransportError(), 1, false, false, true],
    [new SolarmanTransportError(), 2, false, false, false],
    [new Error(stale), 1, false, false, true],
    [new Error(offline), 3, false, false, true],
    [new Error(offline), 2, false, false, false],
    [new Error("Unexpected register values"), 1, false, false, false],
    [new SolarmanTransportError(), 1, true, false, false],
    [new SolarmanTransportError(), 1, false, true, false],
  ]) {
    let classification;
    const runtime = Object.create(TenantRuntime.prototype);
    Object.assign(runtime, {
      writesEnabled: true, controlEnabled: true, paused: true, manualTopup: false,
      journal: { pending }, cleanupRequired: false, telemetry: { deviceState: state },
      clearScheduledPermission: async () => { if (cleanupFails) throw new Error("cleanup not confirmed"); },
      health: { controlFault: async (fault, communication) => { classification = { fault, communication }; } },
      q: async () => {}, events: [],
    });
    await runtime.fail("fixture-execution", error);
    assert.deepEqual(classification, { fault: true, communication: expected });
  }
});

test("mode changes bring monitoring forward without duplicate loops or postponing existing checks", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  let interval = 900000;
  let polls = 0;
  const runtime = Object.create(TenantRuntime.prototype);
  Object.assign(runtime, {
    ready: true,
    client: {},
    hub: { stopping: false },
    stopping: false,
    timer: null,
    nextPollAt: null,
    pollCallback: null,
    queue: async (operation) => operation(),
    evaluate: async () => {
      polls++;
    },
  });
  Object.defineProperty(runtime, "pollMs", { get: () => interval });
  runtime.start();
  runtime.start();
  await settle();
  assert.equal(polls, 1);
  assert.equal(runtime.nextPollAt, 900000);
  t.mock.timers.tick(60000);
  interval = 300000;
  runtime.reschedulePolling();
  assert.equal(runtime.nextPollAt, 360000);
  t.mock.timers.tick(60000);
  runtime.reschedulePolling();
  assert.equal(runtime.nextPollAt, 360000);
  interval = 900000;
  runtime.reschedulePolling();
  assert.equal(runtime.nextPollAt, 360000);
  t.mock.timers.tick(240000);
  await settle();
  assert.equal(polls, 2);
  assert.equal(runtime.nextPollAt, 1260000);
  runtime.stopping = true;
  clearTimeout(runtime.timer);
});
