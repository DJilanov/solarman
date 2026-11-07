/** @param {import('pg').Pool|import('pg').PoolClient} client @returns {Promise<boolean>} */
export async function hasEnergyExperience(client) {
  return (await client.query("SELECT to_regclass('public.energy_experience_settings') IS NOT NULL AS present")).rows[0].present;
}

/** @param {import('pg').Pool|import('pg').PoolClient} client @returns {Promise<boolean>} */
export async function hasEnergyAssistantExpansion(client) {
  return (await client.query("SELECT to_regclass('public.energy_away_periods') IS NOT NULL AS present")).rows[0].present;
}

/** @param {import('pg').Pool|import('pg').PoolClient} client @param {string|null} tenantId @returns {Promise<void>} */
export async function quarantineEnergyAssistantExpansion(client, tenantId) {
  if (!(await hasEnergyAssistantExpansion(client))) return;
  await client.query("UPDATE energy_experience_settings SET revision=revision+1,insights_enabled=false,insights_checked_at=null,insights_assessment=null,auto_replan=false,away_revision=away_revision+1,load_revision=load_revision+1,updated_at=clock_timestamp() WHERE($1::uuid IS NULL OR tenant_id=$1)", [tenantId]);
  await client.query("UPDATE energy_away_periods SET state='quarantined',cancelled_at=COALESCE(cancelled_at,clock_timestamp()),updated_at=clock_timestamp() WHERE($1::uuid IS NULL OR tenant_id=$1) AND state='planned' AND returns_at>clock_timestamp()", [tenantId]);
  await client.query("UPDATE energy_outage_watches SET enabled=false,quarantined=true,revision=revision+1,updated_at=clock_timestamp() WHERE($1::uuid IS NULL OR tenant_id=$1) AND NOT quarantined", [tenantId]);
  await client.query("UPDATE energy_insights SET resolved_at=clock_timestamp(),resolution_reason='quarantined' WHERE($1::uuid IS NULL OR tenant_id=$1) AND resolved_at IS NULL", [tenantId]);
  await client.query("UPDATE notification_outbox SET state=CASE WHEN state='sending' THEN state ELSE 'cancelled' END,cancel_requested_at=COALESCE(cancel_requested_at,clock_timestamp()),completed_at=CASE WHEN state='sending' THEN completed_at ELSE clock_timestamp() END,last_code='settings_changed' WHERE($1::uuid IS NULL OR tenant_id=$1) AND kind IN('energy-insight','outage-notice') AND state IN('queued','retry','sending')", [tenantId]);
}

/** @param {import('pg').Pool|import('pg').PoolClient} client @param {string|null} tenantId @returns {Promise<void>} */
export async function quarantineEnergyExperience(client, tenantId) {
  if (!(await hasEnergyExperience(client))) return;
  await client.query("UPDATE energy_experience_settings SET briefings_enabled=false,revision=revision+1,updated_at=clock_timestamp() WHERE ($1::uuid IS NULL OR tenant_id=$1)", [tenantId]);
  await client.query("UPDATE energy_load_tasks SET reminder_enabled=false,revision=revision+1,updated_at=clock_timestamp() WHERE ($1::uuid IS NULL OR tenant_id=$1) AND reminder_enabled", [tenantId]);
  await quarantineEnergyAssistantExpansion(client, tenantId);
}
