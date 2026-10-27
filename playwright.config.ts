import { defineConfig } from "@playwright/test";
import { existsSync } from "node:fs";

if (existsSync(".env.e2e")) process.loadEnvFile(".env.e2e");
process.env.E2E_EMAIL ??= "e2e-owner@example.test";
process.env.E2E_PASSWORD ??= "e2e-workspace-fixture-password";

export default defineConfig({
  testDir: "./test/e2e",
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: "http://localhost:3000",
    locale: "en-GB",
    viewport: { width: 1440, height: 1100 },
    trace: "off",
    screenshot: "only-on-failure",
  },
  reporter: [["list"]],
  webServer: {
    command: "node scripts/start-e2e.mjs",
    url: "http://localhost:3000/healthz",
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
