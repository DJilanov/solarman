import test from "node:test";
import assert from "node:assert/strict";
import { ApiBudget, apiAppKey } from "../src/api-budget.mjs";
import { customerLaunchStatus } from "../src/customer-launch.mjs";

test("customer admission previews an additional home without reserving capacity, exposing credentials or upgrading the plan", async () => {
  const env = { SOLARMAN_APP_ID: "fixture-shared-app", ENERGY_WEATHER_MODE: "evaluation", ENERGY_WEATHER_EVALUATION_TENANT: "00000000-0000-0000-0000-000000000001" };
  let reads = 0;
  const pool = { async query(sql, parameters) {
    assert.match(sql.trim(), /^SELECT /);
    assert.deepEqual(parameters, [apiAppKey(env.SOLARMAN_APP_ID)]);
    reads++;
    return { rows: [{ monitoring_admitted: true, control_enabled: true }] };
  } };
  const hub = { pool, env, budget: new ApiBudget(pool, env) };
  const result = await customerLaunchStatus(hub, { password_changed_at: null, has_recovery_key: false, has_passkeys: false, mfa_verified_at: null });
  assert.equal(reads, 1);
  assert.equal(result.capacity.controlledHomes, 1);
  assert.equal(result.capacity.nextControl.fits, false);
  assert.ok(result.capacity.currentAnnual <= result.capacity.planningLimit);
  assert.equal(result.capacity.limit, 200000);
  assert.equal(result.customerForecastsConfigured, false);
  assert.equal(JSON.stringify(result).includes(env.SOLARMAN_APP_ID), false);
  assert.deepEqual(result.administrator, { passwordChanged: false, recoveryKeySaved: false, passkeyEnrolled: false, mfaVerified: false });
});

test("a commercial weather key is required before customer forecasts are declared configured", async () => {
  const env = { ENERGY_WEATHER_MODE: "commercial", OPEN_METEO_API_KEY: "fixture-commercial-weather-key" };
  const result = await customerLaunchStatus({ env }, {});
  assert.equal(result.capacity, null);
  assert.equal(result.customerForecastsConfigured, true);
  assert.equal(JSON.stringify(result).includes(env.OPEN_METEO_API_KEY), false);
  await assert.rejects(customerLaunchStatus({ env: { ENERGY_WEATHER_MODE: "commercial" } }, {}), /requires its API key/);
});
