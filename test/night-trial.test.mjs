import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  nightTrialConfig,
  expireNightTrial,
  remindNightTrial,
} from "../src/night-trial.mjs";

const config = {
  version: 1,
  trialId: randomUUID(),
  tenantId: randomUUID(),
  userId: randomUUID(),
  activationKey: randomUUID(),
  stopKey: randomUUID(),
  reviewKey: randomUUID(),
  expiresAt: "2026-11-08T05:15:00.000Z",
  reviewAt: "2026-11-08T07:00:00.000Z",
};
test("night trial jobs reject ambiguous dates, mismatched keys and unknown configuration", () => {
  assert.deepEqual(nightTrialConfig(config), config);
  assert.equal(
    JSON.stringify(
      nightTrialConfig(Object.fromEntries(Object.entries(config).reverse())),
    ),
    JSON.stringify(nightTrialConfig(config)),
  );
  for (const value of [
    null,
    { ...config, tenantId: "invalid" },
    { ...config, stopKey: config.activationKey },
    { ...config, stopKey: config.trialId },
    { ...config, expiresAt: "2026-11-08 05:15" },
    { ...config, reviewAt: config.expiresAt },
    { ...config, reviewAt: "2026-11-10T07:00:00.000Z" },
    { ...config, password: "not-allowed" },
  ])
    assert.throws(() => nightTrialConfig(value));
});
test("night trial timers cannot revoke consent or send a reminder before their deadlines", async () => {
  const pool = {
    connect() {
      throw new Error("Database must not be accessed early");
    },
  };
  const early = Date.parse(config.expiresAt) - 1;
  assert.deepEqual(await expireNightTrial(pool, config, early), {
    state: "not-due",
  });
  assert.deepEqual(await remindNightTrial(pool, config, early), {
    state: "not-due",
  });
});
