import { createServer } from "node:http";
import { dashboardConfig } from "./dashboard-config.mjs";
import { createPool, migrate, bootstrapAdmin } from "./database.mjs";
import { validPasswordHash } from "./auth.mjs";
import { AccountHub } from "./account-hub.mjs";
import { encryptionKey } from "./credentials.mjs";
import { createApp } from "./http-app.mjs";

async function main() {
  const config = dashboardConfig(process.env);
  if (!validPasswordHash(config.adminPasswordHash))
    throw new Error("DASHBOARD_ADMIN_PASSWORD_HASH is invalid");
  const pool = createPool(config.database);
  const key = encryptionKey(config.encryptionSecret);
  let hub;
  let server;
  try {
    await migrate(pool);
    await bootstrapAdmin(
      pool,
      config.adminEmail,
      config.adminPasswordHash,
      key,
      process.env,
    );
    hub = new AccountHub(pool, process.env, key);
    await hub.initialize();
    const handler = createApp({ pool, hub, config });
    server = createServer(
      { requestTimeout: 20_000, headersTimeout: 10_000 },
      (request, response) => {
        handler(request, response).catch(() => {
          response.writeHead(500);
          response.end();
        });
      },
    );
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(config.port, config.host, resolve);
    });
    console.log(
      JSON.stringify({ event: "dashboard_started", port: config.port }),
    );
  } catch (error) {
    await hub?.close();
    await pool.end();
    throw error;
  }
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    try {
      await hub.close();
      await new Promise((resolve) => {
        server.close(resolve);
        server.closeIdleConnections();
      });
      await pool.end();
    } catch {
      process.exitCode = 1;
    }
  };
  process.once("SIGINT", () => {
    void close();
  });
  process.once("SIGTERM", () => {
    void close();
  });
}

main().catch(() => {
  console.error(
    JSON.stringify({
      event: "startup_failed",
      message:
        "Check the private application configuration and PostgreSQL connection",
    }),
  );
  process.exitCode = 1;
});
