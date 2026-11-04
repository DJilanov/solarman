import { randomUUID } from "node:crypto";

/** @param {import('pg').PoolClient} client @param {object} channel @param {string} actor @param {'saved'|'enabled'|'disabled'|'test'|'blocked'} action @returns {Promise<void>} */
export async function recordNotificationChange(client, channel, actor, action) {
  await client.query(
    "INSERT INTO notification_events(id,tenant_id,channel_id,revision,actor,action) VALUES($1,$2,$3,$4,$5,$6)",
    [
      randomUUID(),
      channel.tenant_id,
      channel.id,
      channel.revision,
      actor,
      action,
    ],
  );
}

/** @param {import('pg').PoolClient} client @param {object} channel @param {{id:string,eventKey:string,kind:string,payload:object,incidentId?:string,delaySeconds?:number,cancelCode?:string}} job @returns {Promise<void>} */
export async function enqueueNotification(client, channel, job) {
  await client.query(
    `INSERT INTO notification_outbox(id,tenant_id,channel_id,channel_revision,event_key,incident_id,kind,payload,state,last_code,completed_at,next_attempt_at)
    SELECT $1,$2,$3,$4,$5,$6,$7,$8,CASE WHEN $10::text IS NOT NULL THEN 'cancelled' WHEN busy THEN 'failed' ELSE 'queued' END,COALESCE($10,CASE WHEN busy THEN 'queue_limit' ELSE null END),CASE WHEN busy OR $10::text IS NOT NULL THEN clock_timestamp() ELSE null END,clock_timestamp()+$9*interval '1 second'
    FROM(SELECT count(*)>=100 AS busy FROM notification_outbox WHERE tenant_id=$2 AND state IN('queued','retry','sending'))q
    ON CONFLICT(channel_id,channel_revision,event_key) DO NOTHING`,
    [
      job.id,
      channel.tenant_id,
      channel.id,
      channel.revision,
      job.eventKey,
      job.incidentId ?? null,
      job.kind,
      job.payload,
      job.delaySeconds ?? 0,
      job.cancelCode ?? null,
    ],
  );
}
