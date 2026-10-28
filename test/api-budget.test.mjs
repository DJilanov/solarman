import test from "node:test";
import assert from "node:assert/strict";
import {
  apiAppKey,
  availableBudget,
  budgetConfig,
  monitoringInterval,
  YEAR_MS,
} from "../src/api-budget.mjs";

test("the App ID owns the budget regardless of account or secret rotation", () => {
  assert.match(apiAppKey("fixture-app"), /^[a-f0-9]{64}$/);
  assert.equal(apiAppKey("fixture-app"), apiAppKey(" fixture-app "));
  assert.notEqual(apiAppKey("fixture-app"), apiAppKey("another-app"));
});

test("request limits and a separate recovery reserve are validated", () => {
  assert.deepEqual(budgetConfig({}), { limit: 200000, reserve: 2000 });
  for (const env of [
    { SOLARMAN_API_CALL_LIMIT: "0" },
    { SOLARMAN_API_CALL_LIMIT: "2000" },
    { SOLARMAN_API_CALL_LIMIT: "2e5" },
    { SOLARMAN_API_RECOVERY_RESERVE: "0" },
    { SOLARMAN_API_RECOVERY_RESERVE: "1.5" },
  ])
    assert.throws(() => budgetConfig(env));
});

test("the lower of local allowance and provider balance protects recovery calls", () => {
  const policy = { limit: 100, reserve: 10 };
  assert.deepEqual(availableBudget(20, null, policy), {
    remaining: 80,
    routineRemaining: 70,
    state: "available",
  });
  assert.deepEqual(availableBudget(20, 10, policy), {
    remaining: 10,
    routineRemaining: 0,
    state: "recovery-only",
  });
  assert.deepEqual(availableBudget(100, 80, policy), {
    remaining: 0,
    routineRemaining: 0,
    state: "exhausted",
  });
  assert.equal(availableBudget(5, 0, policy).state, "exhausted");
});

test("shared monitoring slows down without exceeding the supported cadence", () => {
  const policy = budgetConfig({});
  assert.equal(monitoringInterval(300000, 1, 0, policy), 300000);
  assert.equal(monitoringInterval(300000, 2, 0, policy), 360000);
  assert.equal(monitoringInterval(300000, 3, 0, policy), 510000);
  assert.equal(monitoringInterval(900000, 2, 0, policy), 900000);
  for (const consumers of [2, 3, 4]) {
    const interval = monitoringInterval(300000, consumers, 0, policy);
    assert.ok((YEAR_MS * consumers) / interval < policy.limit - policy.reserve);
  }
  assert.equal(monitoringInterval(300000, 1, 210240, policy), 1800000);
  assert.equal(monitoringInterval(300000, 100, 0, policy), 1800000);
});

test("monitoring allocation groups by App ID while separate apps retain their own cadence", async () => {
  const { AccountHub } = await import("../src/account-hub.mjs");
  const hub = new AccountHub({}, {}, Buffer.alloc(32));
  const runtime = (appKey) => ({
    appKey,
    ready: true,
    client: {},
    stopping: false,
    monitorPollMs: 300000,
    controlPollMs: 900000,
    usesControlCycle: () => false,
  });
  const first = runtime(apiAppKey("shared"));
  const second = runtime(apiAppKey("shared"));
  const independent = runtime(apiAppKey("separate"));
  hub.runtimes.set("first", first);
  hub.runtimes.set("second", second);
  hub.runtimes.set("independent", independent);
  assert.equal(hub.monitorPollMs(first), 360000);
  assert.equal(hub.monitorPollMs(second), 360000);
  assert.equal(hub.monitorPollMs(independent), 300000);
});
