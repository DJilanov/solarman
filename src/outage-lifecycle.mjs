/** @param {import('pg').Pool|import('pg').PoolClient} client @returns {Promise<boolean>} */
export async function hasOutageStorage(client) {
  return (
    await client.query(
      "SELECT to_regclass('public.outage_preparations') IS NOT NULL AS present",
    )
  ).rows[0].present;
}

/** @param {import('pg').Pool|import('pg').PoolClient} client @param {string} tenantId @returns {Promise<boolean>} */
export async function outageCleanupPending(client, tenantId) {
  if (!(await hasOutageStorage(client))) return false;
  return (
    await client.query(
      "SELECT EXISTS(SELECT 1 FROM outage_preparations WHERE tenant_id=$1 AND state IN('queued','applying','active','restoring','recovery-required','quarantined')) AS pending",
      [tenantId],
    )
  ).rows[0].pending;
}

/** @param {import('pg').Pool|import('pg').PoolClient} client @param {string|null} tenantId @param {string} reason @returns {Promise<void>} */
export async function quarantineOutage(client, tenantId, reason) {
  // The operations capsule is installed before the application migrates its database.
  if (!(await hasOutageStorage(client))) return;
  await client.query(
    "UPDATE outage_preparations SET state='quarantined',revision=revision+1,last_error=$2,updated_at=clock_timestamp() WHERE ($1::uuid IS NULL OR tenant_id=$1) AND state IN('queued','applying','active','restoring','recovery-required','quarantined')",
    [tenantId, reason],
  );
  await client.query(
    "UPDATE outage_preparations SET approved_at=null,approved_by=null,proof=proof || jsonb_build_object('quarantinedAt',clock_timestamp(),'quarantineReason',$2::text),updated_at=clock_timestamp() WHERE ($1::uuid IS NULL OR tenant_id=$1)",
    [tenantId, reason],
  );
  await client.query(
    "UPDATE outage_write_intents SET status='uncertain' WHERE ($1::uuid IS NULL OR tenant_id=$1) AND status IN('prepared','acknowledged')",
    [tenantId],
  );
  await client.query(
    "UPDATE command_executions SET status='interrupted',completed_at=clock_timestamp(),message='Outage request quarantined; review original inverter settings' WHERE ($1::uuid IS NULL OR tenant_id=$1) AND action IN('outage_prepare','outage_restore','outage_preempt') AND status IN('queued','running')",
    [tenantId],
  );
}
