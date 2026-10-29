import { dashboardConfig } from "../src/dashboard-config.mjs";
import { createPool } from "../src/database.mjs";
import { quarantineControlsForRollback } from "../src/control-quarantine.mjs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { assertRollbackCompatibility } from "./release.mjs";

const pool = createPool(dashboardConfig(process.env).database);
try {
  const workspaces = await quarantineControlsForRollback(pool);
  console.log(
    JSON.stringify({ event: "rollback_controls_quarantined", workspaces }),
  );
  if (process.argv[2]) {
    if (!path.isAbsolute(process.argv[2]))
      throw new Error("An absolute rollback release path is required");
    const versions = (
      await pool.query("SELECT version FROM schema_migrations")
    ).rows.map((row) => row.version);
    const supported = await readdir(path.join(process.argv[2], "migrations"));
    assertRollbackCompatibility(versions, supported);
  }
} catch (error) {
  console.error(
    JSON.stringify({
      event: "rollback_quarantine_or_compatibility_failed",
      message:
        error instanceof Error ? error.message : "Rollback verification failed",
    }),
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
