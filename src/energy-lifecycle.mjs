import { quarantineEnergyExperience } from "./energy-experience-lifecycle.mjs";

/** @param {import('pg').Pool|import('pg').PoolClient} client @returns {Promise<boolean>} */
export async function hasEnergyStorage(client) {
  return (
    await client.query(
      "SELECT to_regclass('public.energy_settings') IS NOT NULL AS present",
    )
  ).rows[0].present;
}

/** @param {import('pg').Pool|import('pg').PoolClient} client @param {string|null} tenantId @param {string} reason @returns {Promise<void>} */
export async function quarantineEnergy(client, tenantId, reason) {
  if (["restore", "rollback"].includes(reason))
    await quarantineEnergyExperience(client, tenantId);
  // Recovery tools are installed before schema upgrades and also open older checkpoints.
  if (!(await hasEnergyStorage(client))) return;
  await client.query(
    "UPDATE energy_settings SET automatic=false,approval_binding=null,approved_by=null,revision=revision+1,last_code=$2,updated_at=clock_timestamp() WHERE ($1::uuid IS NULL OR tenant_id=$1)",
    [tenantId, reason],
  );
  await client.query(
    "UPDATE energy_plans SET state='quarantined',code=$2,updated_at=clock_timestamp() WHERE ($1::uuid IS NULL OR tenant_id=$1) AND state IN('recommended','scheduled','starting','running','restoring')",
    [tenantId, reason],
  );
}
