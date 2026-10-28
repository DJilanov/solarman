import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.mjs";

const env = {
  SOLARMAN_APP_ID: "test-app",
  SOLARMAN_APP_SECRET: "test-secret",
  SOLARMAN_EMAIL: "owner@example.com",
  SOLARMAN_PASSWORD_SHA256: "a".repeat(64),
  SOLARMAN_DEVICE_SN: "TEST-INVERTER",
  CALLBACK_PUBLIC_URL: "https://solar.example.com",
};

test("defaults to read-only, official global API and quota-conscious polling", () => {
  const config = loadConfig(env);
  assert.equal(config.writesEnabled, false);
  assert.equal(config.baseUrl, "https://globalapi.solarmanpv.com");
  assert.equal(config.pollMs, 900_000);
  assert.equal(config.telemetryPollMs, 300_000);
  assert.equal(config.controlAuditMs, 3600_000);
});

test("rejects missing credentials, plaintext passwords and invalid booleans", () => {
  assert.throws(
    () => loadConfig({ ...env, SOLARMAN_APP_SECRET: "" }),
    /Missing/,
  );
  assert.throws(
    () => loadConfig({ ...env, SOLARMAN_PASSWORD_SHA256: "plaintext" }),
    /64 lowercase/,
  );
  assert.throws(
    () => loadConfig({ ...env, WRITES_ENABLED: "yes" }),
    /true or false/,
  );
});

test("accepts SOLARMAN_PASSWORD, hashes it locally and excludes plaintext from configuration", () => {
  const config = loadConfig({
    ...env,
    SOLARMAN_PASSWORD_SHA256: "",
    SOLARMAN_PASSWORD: "password",
  });
  assert.equal(
    config.passwordSha256,
    "5e884898da28047151d0e56f8dc6292773603d0d6aabbdd62a11ef721d1542d8",
  );
  assert.equal("password" in config, false);
  assert.throws(
    () => loadConfig({ ...env, SOLARMAN_PASSWORD: "password" }),
    /only one/,
  );
});

test("credentials cannot be sent to a nonofficial host or redirected origin", () => {
  for (const url of [
    "http://globalapi.solarmanpv.com",
    "https://example.com",
    "https://globalapi.solarmanpv.com/other",
    "https://name:password@globalapi.solarmanpv.com",
    "https://globalapi.solarmanpv.com?key=secret",
  ]) {
    assert.throws(
      () => loadConfig({ ...env, SOLARMAN_BASE_URL: url }),
      /official/,
    );
  }
  assert.throws(
    () =>
      loadConfig({ ...env, CALLBACK_PUBLIC_URL: "http://solar.example.com" }),
    /HTTPS/,
  );
});

test("charge window must outlast the polling interval with a margin", () => {
  assert.throws(
    () => loadConfig({ ...env, CHARGE_WINDOW_MINUTES: "15" }),
    /exceed/,
  );
  assert.throws(
    () => loadConfig({ ...env, POLL_SECONDS: "not-a-number" }),
    /Invalid integer/,
  );
  assert.throws(
    () => loadConfig({ ...env, INVERTER_TIMEZONE: "invalid/timezone" }),
    RangeError,
  );
});
