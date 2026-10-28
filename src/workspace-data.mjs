import { createHash } from "node:crypto";
import { AccountSecurity, SecurityError } from "./account-security.mjs";
import { historyEvidence } from "./command-history.mjs";

const EXPORT_SECTIONS = {
  workspace:
    "SELECT id,name,created_at,lifecycle,lifecycle_revision::text,lifecycle_changed_at,lifecycle_message FROM tenants WHERE id=$1",
  members:
    "SELECT id,email,created_at FROM users WHERE tenant_id=$1 ORDER BY created_at,id",
  provider:
    "SELECT id,email,device_sn,profile,station_id,timezone,discovered_devices,connection_status,connection_message,validated_at,created_at,updated_at FROM solarman_accounts WHERE tenant_id=$1",
  measurements:
    "SELECT id::text,account_id,device,observed_at,received_at,soc,temperature_c,pv_w,load_w,grid_w,battery_w,ac_enabled,reading_source,sampling_seconds,snapshot FROM measurements WHERE tenant_id=$1 ORDER BY observed_at,id",
  providerReadings:
    "SELECT id::text,account_id,device,collected_at,received_at,data_list FROM provider_readings WHERE tenant_id=$1 ORDER BY id",
  commands:
    "SELECT id,account_id,device,actor,action,status,message,detail,created_at,completed_at FROM command_executions WHERE tenant_id=$1 ORDER BY created_at,id",
  commandReceipts:
    "SELECT idempotency_key,action,completed_at FROM command_receipts WHERE tenant_id=$1 AND user_id=$2 ORDER BY completed_at,idempotency_key",
  writes:
    "SELECT id,account_id,device,execution_id,operation,address,register_values,status,created_at,acknowledged_at,verified_at,reconciled_at FROM inverter_write_intents WHERE tenant_id=$1 ORDER BY created_at,id",
  cleanup:
    "SELECT account_id,device,state,confirmed_off_at,updated_at FROM device_control_state WHERE tenant_id=$1 ORDER BY account_id,device",
  deviceHealth:
    "SELECT account_id,device,created_at,attempted_at,succeeded_at,failed_at,uploaded_at,reported_at,device_state,failures,control_fault,control_fault_at,auth_fault,auth_fault_at FROM device_health WHERE tenant_id=$1 ORDER BY account_id,device",
  controller:
    "SELECT paused,manual_topup,control_enabled,verification,topup_expires_at,control_epoch::text,updated_at FROM controller_state WHERE tenant_id=$1",
  incidents:
    "SELECT id,account_id,device,kind,severity,detail_code,first_seen_at,last_seen_at,resolved_at,resolution_reason,acknowledged_at,revision FROM operational_incidents WHERE tenant_id=$1 ORDER BY first_seen_at,id",
  usage:
    "SELECT id::text,account_id,kind,purpose,created_at FROM api_requests WHERE tenant_id=$1 ORDER BY created_at,id",
  workspaceChanges:
    "SELECT id,revision::text,state,message,created_at FROM tenant_lifecycle_events WHERE tenant_id=$1 ORDER BY revision",
  closure:
    "SELECT id,requested_at,erasure_authorized_at,offsite_acknowledged_at,erasure_started_at,completed_at,last_failed_at,removed_rows::text FROM workspace_offboarding WHERE tenant_id=$1",
  observations:
    "SELECT id,account_id,device,identity,verification,state,reason,started_at,ended_at,checked_at,failed_at,progress FROM policy_observation_runs WHERE tenant_id=$1 ORDER BY started_at,id",
  notificationChannels:
    "SELECT id,kind,chat_id,language,enabled,quarantined,revision::text,verified_at,last_test_at,created_at,updated_at FROM notification_channels WHERE tenant_id=$1",
  notifications:
    "SELECT id,channel_id,channel_revision::text,event_key,incident_id,kind,payload,state,attempts,had_unconfirmed,next_attempt_at,created_at,completed_at,cancel_requested_at,last_code,message_id::text FROM notification_outbox WHERE tenant_id=$1 ORDER BY created_at,id",
  notificationAttempts:
    "SELECT id,job_id,number,state,code,started_at,completed_at,message_id::text FROM notification_attempts WHERE tenant_id=$1 ORDER BY started_at,id",
  notificationChanges:
    "SELECT id,channel_id,revision::text,actor,action,created_at FROM notification_events WHERE tenant_id=$1 ORDER BY created_at,id",
  commissioning:
    "SELECT id,account_id,device,identity,verification,state,revision::text,attended_until,evidence,reason,created_at,updated_at,ended_at FROM control_commissioning WHERE tenant_id=$1 ORDER BY created_at,id",
  commissioningEvents:
    "SELECT id,run_id,revision::text,action,detail,created_at FROM commissioning_events WHERE tenant_id=$1 ORDER BY created_at,id",
  retention:
    "SELECT enabled,measurement_days,activity_days,revision::text,updated_at,last_run_at,last_failed_at,last_counts FROM workspace_retention WHERE tenant_id=$1",
  retentionChanges:
    "SELECT id,revision::text,enabled,measurement_days,activity_days,created_at FROM retention_policy_events WHERE tenant_id=$1 ORDER BY revision",
  browserSessions:
    "SELECT id,user_agent,created_at,last_seen_at,expires_at FROM sessions WHERE user_id=$2 AND EXISTS (SELECT 1 FROM users WHERE id=$2 AND tenant_id=$1) ORDER BY created_at,id",
  security:
    "SELECT id,kind,affected_sessions,occurred_at FROM account_security_events WHERE tenant_id=$1 AND user_id=$2 ORDER BY occurred_at,id",
  recovery:
    "SELECT kind,created_at,expires_at,used_at,revoked_at FROM account_recovery_tokens WHERE user_id=$2 AND EXISTS (SELECT 1 FROM users WHERE id=$2 AND tenant_id=$1) ORDER BY created_at,id",
};

/** @param {import('node:http').ServerResponse} response @param {string} chunk @returns {Promise<void>} */
async function writeChunk(response, chunk) {
  if (response.destroyed)
    throw new SecurityError(499, "Archive download was interrupted");
  if (response.write(chunk)) return;
  await new Promise((resolve, reject) => {
    const finish = (error) => {
      clearTimeout(timer);
      response.off("drain", drained);
      response.off("close", closed);
      response.off("error", closed);
      error ? reject(error) : resolve();
    };
    const drained = () => finish(null);
    const closed = () =>
      finish(new SecurityError(499, "Archive download was interrupted"));
    const timer = setTimeout(
      () => finish(new SecurityError(408, "Archive download was interrupted")),
      5000,
    );
    response.once("drain", drained);
    response.once("close", closed);
    response.once("error", closed);
  });
}

export class WorkspaceData {
  /** @param {import('pg').Pool} pool @param {{batchRows?:number,maxBytes?:number}} [options] */
  constructor(pool, options = {}) {
    this.pool = pool;
    this.security = new AccountSecurity(pool);
    this.exports = new Set();
    this.batchRows = options.batchRows ?? 500;
    this.maxBytes = options.maxBytes ?? 128 * 1024 * 1024;
    if (
      !Number.isInteger(this.batchRows) ||
      this.batchRows < 1 ||
      this.batchRows > 1000 ||
      !Number.isSafeInteger(this.maxBytes) ||
      this.maxBytes < 1
    )
      throw new Error("Invalid archive limits");
  }

  /** @param {{id:string,tenant_id:string,token_hash:string}} session @param {unknown} password @returns {Promise<void>} */
  async authorize(session, password) {
    const hash = await this.security.confirmedPassword(session.id, password);
    await this.security.withUser(session.id, async (client, user) => {
      await this.security.activeSession(client, session);
      if (user.tenant_id !== session.tenant_id || user.password_hash !== hash)
        throw new SecurityError(
          409,
          "Your account changed. Refresh this page and try again.",
        );
    });
  }

  /** @param {string} tenantId @returns {Promise<object>} */
  async retention(tenantId) {
    const row = (
      await this.pool.query(
        `SELECT COALESCE(r.enabled,false) AS enabled,COALESCE(r.measurement_days,365) AS "measurementDays",COALESCE(r.activity_days,730) AS "activityDays",COALESCE(r.revision,0)::text AS revision,r.last_run_at AS "lastRunAt",r.last_failed_at AS "lastFailedAt",COALESCE(r.last_counts,'{}') AS "lastCounts",
      COALESCE((SELECT jsonb_agg(e ORDER BY e.revision::bigint DESC) FROM (SELECT revision::text,enabled,measurement_days AS "measurementDays",activity_days AS "activityDays",created_at AS at FROM retention_policy_events WHERE tenant_id=t.id ORDER BY retention_policy_events.revision DESC LIMIT 20)e),'[]') AS events
      FROM tenants t LEFT JOIN workspace_retention r ON r.tenant_id=t.id WHERE t.id=$1`,
        [tenantId],
      )
    ).rows[0];
    if (!row) throw new SecurityError(404, "Workspace not found");
    return row;
  }

  /** @param {{id:string,tenant_id:string,token_hash:string}} session @param {{currentPassword:unknown,enabled:unknown,measurementDays:unknown,activityDays:unknown,revision:unknown}} body @returns {Promise<object>} */
  async updateRetention(session, body) {
    if (
      typeof body.enabled !== "boolean" ||
      !Number.isInteger(body.measurementDays) ||
      body.measurementDays < 1 ||
      body.measurementDays > 3650 ||
      !Number.isInteger(body.activityDays) ||
      body.activityDays < 30 ||
      body.activityDays > 3650 ||
      typeof body.revision !== "string" ||
      !/^\d{1,18}$/.test(body.revision)
    )
      throw new SecurityError(
        400,
        "Choose valid retention periods and a current policy revision",
      );
    const hash = await this.security.confirmedPassword(
      session.id,
      body.currentPassword,
    );
    await this.security.withUser(session.id, async (client, user) => {
      await this.security.activeSession(client, session);
      if (user.tenant_id !== session.tenant_id || user.password_hash !== hash)
        throw new SecurityError(
          409,
          "Your account changed. Refresh this page and try again.",
        );
      const tenant = (
        await client.query(
          "SELECT lifecycle FROM tenants WHERE id=$1 FOR SHARE",
          [session.tenant_id],
        )
      ).rows[0];
      if (!tenant || !["active", "suspended"].includes(tenant.lifecycle))
        throw new SecurityError(409, "Workspace data changes are unavailable");
      const existing = (
        await client.query(
          "SELECT revision::text FROM workspace_retention WHERE tenant_id=$1 FOR UPDATE",
          [session.tenant_id],
        )
      ).rows[0];
      if ((existing?.revision ?? "0") !== body.revision)
        throw new SecurityError(
          409,
          "Retention policy changed. Refresh before saving again.",
        );
      const row = (
        await client.query(
          `INSERT INTO workspace_retention(tenant_id,enabled,measurement_days,activity_days,revision) VALUES ($1,$2,$3,$4,1)
        ON CONFLICT(tenant_id) DO UPDATE SET enabled=EXCLUDED.enabled,measurement_days=EXCLUDED.measurement_days,activity_days=EXCLUDED.activity_days,revision=workspace_retention.revision+1,updated_at=clock_timestamp(),next_run_at=clock_timestamp() RETURNING revision`,
          [
            session.tenant_id,
            body.enabled,
            body.measurementDays,
            body.activityDays,
          ],
        )
      ).rows[0];
      await client.query(
        "INSERT INTO retention_policy_events(tenant_id,revision,enabled,measurement_days,activity_days,actor_id) VALUES($1,$2,$3,$4,$5,$6)",
        [
          session.tenant_id,
          row.revision,
          body.enabled,
          body.measurementDays,
          body.activityDays,
          user.id,
        ],
      );
    });
    return this.retention(session.tenant_id);
  }

  /** @param {{id:string,tenant_id:string,token_hash:string}} session @param {unknown} password @param {import('node:http').ServerResponse} response @returns {Promise<void>} */
  async archive(session, password, response) {
    if (this.exports.size >= 2 || this.exports.has(session.tenant_id))
      throw new SecurityError(
        429,
        "An archive is already being prepared. Try again shortly.",
      );
    this.exports.add(session.tenant_id);
    let client;
    let snapshotOpen = false;
    const deadline = setTimeout(() => response.destroy(), 120_000);
    deadline.unref();
    try {
      await this.authorize(session, password);
      client = await this.pool.connect();
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      snapshotOpen = true;
      await client.query("SET LOCAL statement_timeout='5s'");
      let bytes = 0;
      const hash = createHash("sha256");
      const counts = {};
      const emit = async (value) => {
        const chunk = JSON.stringify(value) + "\n";
        bytes += Buffer.byteLength(chunk);
        if (bytes > this.maxBytes)
          throw new SecurityError(
            413,
            "The workspace archive exceeds the download limit",
          );
        hash.update(chunk);
        await writeChunk(response, chunk);
      };
      response.writeHead(200, {
        "content-type": "application/x-ndjson; charset=utf-8",
        "cache-control": "no-store",
        "content-disposition": `attachment; filename="solarman-workspace-${new Date().toISOString().slice(0, 10)}.ndjson"`,
      });
      await emit({
        type: "manifest",
        version: 1,
        exportedAt: new Date().toISOString(),
        sections: Object.keys(EXPORT_SECTIONS),
        securityScope: "current-user",
        format: "ndjson",
      });
      for (const [section, sql] of Object.entries(EXPORT_SECTIONS)) {
        counts[section] = 0;
        await client.query(
          `DECLARE workspace_export_rows NO SCROLL CURSOR FOR ${sql}`,
          sql.includes("$2")
            ? [session.tenant_id, session.id]
            : [session.tenant_id],
        );
        while (true) {
          const alive = await this.pool.query(
            "SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND u.id=$2 AND u.tenant_id=$3 AND s.expires_at>clock_timestamp()",
            [session.token_hash, session.id, session.tenant_id],
          );
          if (!alive.rowCount)
            throw new SecurityError(401, "Sign in to continue");
          const rows = (
            await client.query(
              `FETCH FORWARD ${this.batchRows} FROM workspace_export_rows`,
            )
          ).rows;
          for (const row of rows) {
            let data = row;
            if (section === "commands") {
              const { detail, ...metadata } = row;
              data = { ...metadata, evidence: historyEvidence(detail) };
            }
            await emit({ type: "record", section, data });
            counts[section]++;
          }
          if (rows.length < this.batchRows) break;
        }
        await client.query("CLOSE workspace_export_rows");
      }
      await client.query("COMMIT");
      snapshotOpen = false;
      const completion =
        JSON.stringify({
          type: "complete",
          counts,
          sha256: hash.digest("hex"),
        }) + "\n";
      if (bytes + Buffer.byteLength(completion) > this.maxBytes)
        throw new SecurityError(
          413,
          "The workspace archive exceeds the download limit",
        );
      await writeChunk(response, completion);
      response.end();
    } catch (error) {
      if (response.headersSent) response.destroy();
      throw error;
    } finally {
      clearTimeout(deadline);
      if (client) {
        let discard = false;
        try {
          if (snapshotOpen) await client.query("ROLLBACK");
        } catch {
          discard = true;
        }
        client.release(discard);
      }
      this.exports.delete(session.tenant_id);
    }
  }
}
