/** @param {import('pg').Pool|import('pg').PoolClient} client @returns {Promise<boolean>} */
export async function hasEnergyExperience(client) {
  return (await client.query("SELECT to_regclass('public.energy_experience_settings') IS NOT NULL AS present")).rows[0].present;
}

/** @param {import('pg').Pool|import('pg').PoolClient} client @param {string|null} tenantId @returns {Promise<void>} */
export async function quarantineEnergyExperience(client, tenantId) {
  if (!(await hasEnergyExperience(client))) return;
  await client.query("UPDATE energy_experience_settings SET briefings_enabled=false,revision=revision+1,updated_at=clock_timestamp() WHERE ($1::uuid IS NULL OR tenant_id=$1)", [tenantId]);
  await client.query("UPDATE energy_load_tasks SET reminder_enabled=false,revision=revision+1,updated_at=clock_timestamp() WHERE ($1::uuid IS NULL OR tenant_id=$1) AND reminder_enabled", [tenantId]);
}
