import { existsSync } from "node:fs";

if (existsSync(".env")) process.loadEnvFile(".env");
process.env.DB_NAME = "solarman_test";
process.env.PUBLIC_URL = "http://localhost:3000";
process.env.WRITES_ENABLED = "false";
process.env.SOLARMAN_APP_ID = "";
process.env.SOLARMAN_APP_SECRET = "";
await import("../src/server.mjs");
