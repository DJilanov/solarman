import test from "node:test";
import assert from "node:assert/strict";
import { deviceIssues, Operations } from "../src/operations.mjs";
import { AccountHub } from "../src/account-hub.mjs";

const now = Date.parse("2026-10-28T13:00:00Z");
const recent = {
  created_at: new Date(now - 600000),
  uploaded_at: new Date(now - 120000),
  device_state: 1,
  failures: 0,
  control_fault: false,
};

test("successful communication never makes an old upload fresh", () => {
  const issues = deviceIssues(
    {
      ...recent,
      uploaded_at: new Date(now - 781000),
      succeeded_at: new Date(now),
    },
    now,
    300000,
  );
  assert.deepEqual(
    issues.map((issue) => issue.kind),
    ["telemetry_stale"],
  );
  assert.deepEqual(deviceIssues(recent, now, 300000), []);
  assert.deepEqual(
    deviceIssues(
      { ...recent, uploaded_at: new Date(now - 600000) },
      now,
      300000,
    ),
    [],
  );
  assert.deepEqual(
    deviceIssues(
      { ...recent, uploaded_at: null, created_at: null },
      now,
      300000,
    ),
    [],
  );
  assert.deepEqual(
    deviceIssues(
      { ...recent, uploaded_at: new Date(now - 600000) },
      now,
      900000,
    ),
    [],
  );
});

test("offline status, consecutive failures and control faults are independent evidence", () => {
  assert.deepEqual(deviceIssues({ ...recent, failures: 2 }, now, 300000), []);
  const issues = deviceIssues(
    { ...recent, failures: 3, device_state: 3, control_fault: true },
    now,
    300000,
  );
  assert.deepEqual(
    issues.map((issue) => issue.kind),
    ["device_offline", "request_failures", "control_fault"],
  );
  assert.equal(issues[0].severity, "critical");
  assert.equal(issues[1].severity, "warning");
});

test("failed retries do not invent a newer offline report or move the original control fault time", () => {
  const reported = new Date(now - 300000);
  const fault = new Date(now - 200000);
  const issues = deviceIssues(
    {
      ...recent,
      device_state: 2,
      reported_at: reported,
      attempted_at: new Date(now),
      control_fault: true,
      control_fault_at: fault,
      failed_at: new Date(now - 500000),
    },
    now,
    300000,
  );
  assert.equal(
    issues.find((issue) => issue.kind === "device_offline").at,
    reported,
  );
  assert.equal(
    issues.find((issue) => issue.kind === "control_fault").at,
    fault,
  );
});

test("operational checks coalesce, shutdown drains the active check and a late heartbeat is visible", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now });
  const monitor = new Operations({}, { stopping: false });
  let release;
  let checks = 0;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  monitor.inspect = async () => {
    checks++;
    await gate;
    monitor.checkedAt = Date.now();
  };
  monitor.start();
  monitor.start();
  assert.equal(checks, 1);
  assert.equal(monitor.refresh(), monitor.pending);
  let stopped = false;
  const done = monitor.stop().then(() => {
    stopped = true;
  });
  await Promise.resolve();
  assert.equal(stopped, false);
  release();
  await done;
  assert.equal(monitor.status().state, "current");
  t.mock.timers.tick(180001);
  assert.equal(checks, 1);
  assert.equal(monitor.status().state, "delayed");
});

test("a pending monitor does not postpone inverter cleanup during shutdown", async () => {
  const hub = new AccountHub({}, {}, Buffer.alloc(32));
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let cleanup = false;
  hub.operations.stop = async () => {
    await gate;
  };
  hub.runtimes.set("test", {
    close: async () => {
      cleanup = true;
    },
  });
  const closing = hub.close();
  await Promise.resolve();
  assert.equal(cleanup, true);
  release();
  await closing;
});
