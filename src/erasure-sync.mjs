import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { createPool } from "./database.mjs";
import { dashboardConfig } from "./dashboard-config.mjs";
import { backupClient, verifyBucket } from "./backup.mjs";
import { publishErasures } from "./erasure-publisher.mjs";
import { ErasureGuardError } from "./erasure-guard.mjs";

/** @param {object} config @returns {Promise<object>} */
export async function syncErasures(config) {
  const env = parseEnv(await readFile(config.appEnv, "utf8"));
  const database = dashboardConfig(env).database;
  if (database.database !== config.database || database.host !== "127.0.0.1")
    throw new ErasureGuardError("erasure_database_invalid");
  const pool = createPool({ ...database, max: 1 });
  let connection;
  let client;
  try {
    connection = await pool.connect();
    if (
      !(
        await connection.query(
          "SELECT pg_try_advisory_lock(193401,5) AS acquired",
        )
      ).rows[0].acquired
    )
      throw new ErasureGuardError("erasure_sync_running");
    client = await backupClient(config);
    await verifyBucket(client, config);
    return await publishErasures(client, config, connection);
  } finally {
    client?.destroy();
    try {
      if (connection) {
        try {
          await connection.query("SELECT pg_advisory_unlock(193401,5)");
        } finally {
          connection.release();
        }
      }
    } finally {
      await pool.end();
    }
  }
}
