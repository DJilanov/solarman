import { dashboardConfig } from "../src/dashboard-config.mjs";
import { createPool } from "../src/database.mjs";
import { quarantineControlsForRollback } from "../src/control-quarantine.mjs";

const pool = createPool(dashboardConfig(process.env).database);
try {
  const workspaces = await quarantineControlsForRollback(pool);
  console.log(
    JSON.stringify({ event: "rollback_controls_quarantined", workspaces }),
  );
} catch {
  console.error(
    JSON.stringify({ event: "rollback_control_quarantine_failed" }),
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
