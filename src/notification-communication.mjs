import { randomUUID } from "node:crypto";
import { enqueueNotification } from "./notification-store.mjs";
import { incidentNotification } from "./notification-messages.mjs";

const COMMUNICATION_KINDS = new Set([
  "telemetry_stale", "request_failures", "device_offline", "control_fault",
]);
const CONFIRM_SECONDS = 15 * 60;

/** @param {object} incident @returns {boolean} */
function communicationWarning(incident) {
  return incident.severity === "warning" && COMMUNICATION_KINDS.has(incident.kind);
}

/** @param {import('pg').PoolClient} client @param {object} channel @param {string} reference @param {string} code @returns {Promise<void>} */
async function cancelWarnings(client, channel, reference, code) {
  await client.query(
    `UPDATE notification_outbox SET cancel_requested_at=clock_timestamp(),last_code=$4,
     state=CASE WHEN state='sending' THEN state ELSE 'cancelled' END,
     completed_at=CASE WHEN state='sending' THEN completed_at ELSE clock_timestamp() END
     WHERE channel_id=$1 AND channel_revision=$2 AND payload->>'communicationReference'=$3
     AND kind IN('opened','escalated') AND state IN('queued','retry','sending')`,
    [channel.id, channel.revision, reference, code],
  );
}

/**
 * Keep the operational incidents separate while delivering one durable communication episode.
 * The caller holds the tenant and destination locks used by incident reconciliation.
 * @param {import('pg').PoolClient} client @param {object} channel @param {object} incident
 * @param {'opened'|'escalated'|'resolved'} kind @param {string} origin @returns {Promise<boolean>}
 */
export async function captureCommunication(client, channel, incident, kind, origin) {
  if (!COMMUNICATION_KINDS.has(incident.kind)) return false;
  let reference = (await client.query(
    `SELECT payload->>'communicationReference' AS reference FROM notification_outbox
     WHERE channel_id=$1 AND channel_revision=$2 AND incident_id=$3 AND payload ? 'communicationReference'
     ORDER BY created_at,id LIMIT 1`,
    [channel.id, channel.revision, incident.id],
  )).rows[0]?.reference;
  if (!reference && (kind !== "opened" || !communicationWarning(incident))) return false;

  if (!reference) {
    reference = (await client.query(
      `SELECT j.payload->>'communicationReference' AS reference FROM notification_outbox j
       JOIN operational_incidents i ON i.tenant_id=j.tenant_id AND i.id=j.incident_id
       WHERE j.channel_id=$1 AND j.channel_revision=$2 AND i.binding=$3
       AND j.kind='opened' AND j.payload->>'communicationReference'=j.incident_id::text
       AND NOT EXISTS(SELECT 1 FROM notification_outbox r WHERE r.channel_id=j.channel_id
         AND r.channel_revision=j.channel_revision AND r.payload->>'communicationReference'=j.payload->>'communicationReference'
         AND r.payload->>'communicationClosed'='true')
       ORDER BY j.created_at,j.id LIMIT 1`,
      [channel.id, channel.revision, incident.binding],
    )).rows[0]?.reference ?? incident.id;
  }

  const id = randomUUID();
  const options = { language: channel.language, name: channel.name, origin, reference: id };
  const payload = incidentNotification(incident, kind, options);
  payload.communicationReference = reference;
  let cancelCode;
  let delaySeconds = 0;

  if (kind === "opened") {
    if (reference === incident.id) delaySeconds = CONFIRM_SECONDS;
    else cancelCode = "communication_related";
  } else if (kind === "escalated") {
    // A reported alarm or a non-communication control fault bypasses the waiting period.
    await cancelWarnings(client, channel, reference, "communication_escalated");
  } else {
    const remaining = (await client.query(
      `SELECT EXISTS(SELECT 1 FROM operational_incidents i
       JOIN notification_outbox j ON j.tenant_id=i.tenant_id AND j.incident_id=i.id
       WHERE j.channel_id=$1 AND j.channel_revision=$2 AND j.payload->>'communicationReference'=$3
       AND i.resolved_at IS NULL) AS active`,
      [channel.id, channel.revision, reference],
    )).rows[0].active;
    if (remaining) cancelCode = "communication_related";
    else {
      payload.communicationClosed = true;
      const attempted = (await client.query(
        `SELECT EXISTS(SELECT 1 FROM notification_outbox WHERE channel_id=$1 AND channel_revision=$2
         AND payload->>'communicationReference'=$3 AND kind IN('opened','escalated') AND attempts>0) AS attempted`,
        [channel.id, channel.revision, reference],
      )).rows[0].attempted;
      await cancelWarnings(client, channel, reference, "incident_resolved");
      if (!attempted) cancelCode = "incident_cleared_before_delivery";
    }
  }
  if (kind !== "escalated" && incident.resolution_reason !== "binding_changed") {
    const bg = channel.language === "bg";
    const title = kind === "resolved"
      ? bg ? "Сигналът за връзката със SOLARMAN е изчистен" : "SOLARMAN connection alert cleared"
      : bg ? "Връзката със SOLARMAN изисква внимание" : "SOLARMAN connection needs attention";
    const lines = payload.text.split("\n");
    lines[2] = title;
    payload.text = lines.join("\n");
    payload.title = title;
  }
  await enqueueNotification(client, channel, {
    id, kind, incidentId: incident.id, eventKey: `${incident.id}:${incident.revision}:${kind}`,
    payload, delaySeconds, cancelCode,
  });
  return true;
}
