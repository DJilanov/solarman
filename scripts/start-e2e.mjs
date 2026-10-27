import { existsSync } from "node:fs";
import { hashPassword } from "../src/auth.mjs";

if (existsSync(".env")) process.loadEnvFile(".env");
process.env.DB_NAME = "solarman_test";
process.env.PUBLIC_URL = "http://localhost:3000";
process.env.LISTEN_HOST = "127.0.0.1";
process.env.PORT = "3000";
process.env.WRITES_ENABLED = "false";
process.env.SOLARMAN_APP_ID = "";
process.env.SOLARMAN_APP_SECRET = "";
process.env.DASHBOARD_ADMIN_EMAIL =
  process.env.E2E_EMAIL ?? "e2e-owner@example.test";
process.env.DASHBOARD_ADMIN_PASSWORD_HASH = await hashPassword(
  process.env.E2E_PASSWORD ?? "e2e-workspace-fixture-password",
);
process.env.SOLARMAN_EMAIL = "e2e-provider@example.test";
process.env.SOLARMAN_PASSWORD = "e2e-provider-fixture-password";
delete process.env.SOLARMAN_PASSWORD_SHA256;
process.env.SOLARMAN_DEVICE_SN = "";
await import("../src/server.mjs");
