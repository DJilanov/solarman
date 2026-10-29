import { quarantineWorkspace } from "./tenant-lifecycle.mjs";
import { quarantineNotifications } from "./notification-lifecycle.mjs";

/** @param {import('pg').Pool} pool @returns {Promise<number>} */
export async function quarantineControlsForRollback(pool) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout='5s'");
    await client.query("SET LOCAL statement_timeout='30s'");
    const controls = (
      await client.query(
        "SELECT tenant_id,control_enabled FROM controller_state ORDER BY tenant_id FOR UPDATE",
      )
    ).rows;
    for (const control of controls)
      await quarantineWorkspace(
        client,
        control.tenant_id,
        control.control_enabled,
        "rollback",
      );
    await quarantineNotifications(client, null, "rollback");
    await client.query("COMMIT");
    return controls.length;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
