/** @param {import('pg').Pool|import('pg').PoolClient} client @param {string|null} tenantId @param {'closed'|'restore'} reason @returns {Promise<void>} */
export async function quarantineNotifications(client, tenantId, reason) {
  await client.query(
    `WITH changed AS (UPDATE notification_channels SET enabled=false,quarantined=true,revision=revision+1,verified_at=null,updated_at=clock_timestamp()
    WHERE($1::uuid IS NULL OR tenant_id=$1) AND NOT quarantined RETURNING tenant_id,id,revision)
    INSERT INTO notification_events(id,tenant_id,channel_id,revision,actor,action)
      SELECT gen_random_uuid(),tenant_id,id,revision,'System',$2 FROM changed`,
    [tenantId, reason],
  );
  await client.query(
    `UPDATE notification_outbox SET cancel_requested_at=COALESCE(cancel_requested_at,clock_timestamp()),
    state=CASE WHEN state='sending' THEN state ELSE 'cancelled' END,
    completed_at=CASE WHEN state='sending' THEN completed_at ELSE clock_timestamp() END,last_code=$2
    WHERE($1::uuid IS NULL OR tenant_id=$1) AND state IN('queued','retry','sending')`,
    [tenantId, reason],
  );
  if (reason === "restore") {
    await client.query(
      "UPDATE notification_attempts SET state='unconfirmed',code='restore',completed_at=clock_timestamp() WHERE state='sending' AND($1::uuid IS NULL OR tenant_id=$1)",
      [tenantId],
    );
    await client.query(
      "UPDATE notification_outbox SET state='cancelled',had_unconfirmed=true,last_code='restore',completed_at=clock_timestamp() WHERE state='sending' AND($1::uuid IS NULL OR tenant_id=$1)",
      [tenantId],
    );
  }
}
