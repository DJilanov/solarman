import test from "node:test";
import assert from "node:assert/strict";
import { TenantRuntime } from "../src/tenant-runtime.mjs";

const settle = () => new Promise((resolve) => setImmediate(resolve));

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
