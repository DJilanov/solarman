import { randomUUID } from "node:crypto";
import { AccountSecurity, SecurityError } from "./account-security.mjs";
import {
  encryptNotificationSecret,
  decryptNotificationSecret,
  validTelegramChat,
  validTelegramToken,
} from "./notification-secrets.mjs";
import { sendTelegram } from "./telegram.mjs";
import {
  incidentNotification,
  testNotification,
} from "./notification-messages.mjs";
import { readBackupStatus } from "./backup-status.mjs";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const RETRY_SECONDS = [60, 300, 900];

/** @param {import('pg').PoolClient} client @param {object} channel @param {string} actor @param {'saved'|'enabled'|'disabled'|'test'|'blocked'} action @returns {Promise<void>} */
async function recordChange(client, channel, actor, action) {
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

/** @param {import('pg').PoolClient} client @param {object} channel @param {{id:string,eventKey:string,kind:string,payload:object,incidentId?:string}} job @returns {Promise<void>} */
async function enqueue(client, channel, job) {
  await client.query(
    `INSERT INTO notification_outbox(id,tenant_id,channel_id,channel_revision,event_key,incident_id,kind,payload,state,last_code,completed_at)
    SELECT $1,$2,$3,$4,$5,$6,$7,$8,CASE WHEN busy THEN 'failed' ELSE 'queued' END,CASE WHEN busy THEN 'queue_limit' ELSE null END,CASE WHEN busy THEN clock_timestamp() ELSE null END
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
    ],
  );
}

export class Notifications {
  /** @param {import('pg').Pool} pool @param {object} hub @param {{send?:typeof sendTelegram}} [options] */
  constructor(pool, hub, options = {}) {
    this.pool = pool;
    this.hub = hub;
    this.security = new AccountSecurity(pool);
    this.send = options.send ?? sendTelegram;
    this.origin = new URL(hub.env.PUBLIC_URL ?? "http://localhost").origin;
    this.startedAt = null;
    this.checkedAt = null;
    this.platformAt = 0;
    this.timer = null;
    this.pending = null;
    this.inFlight = null;
    this.stopping = false;
  }

  /** @returns {{state:'starting'|'current'|'delayed',checkedAt:string|null}} */
  status() {
    return {
      state:
        Date.now() - (this.checkedAt ?? this.startedAt ?? Date.now()) > 60000
          ? "delayed"
          : this.checkedAt === null
            ? "starting"
            : "current",
      checkedAt:
        this.checkedAt === null ? null : new Date(this.checkedAt).toISOString(),
    };
  }

  /** @param {string} tenantId @param {number} [offset] @returns {Promise<object>} */
  async settings(tenantId, offset = 0) {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 50000)
      throw new SecurityError(400, "Choose a valid notification history page");
    const [channel, jobs, events, tenant] = await Promise.all([
      this.pool.query(
        'SELECT id,kind,chat_id AS "chatId",language,enabled,quarantined,revision::text,verified_at AS "verifiedAt",last_test_at AS "lastTestAt",blocked_code AS "blockedCode",secret IS NOT NULL AS configured FROM notification_channels WHERE tenant_id=$1',
        [tenantId],
      ),
      this.pool.query(
        `SELECT j.id,j.kind,j.state,j.attempts,j.had_unconfirmed AS "hadUnconfirmed",j.created_at AS "createdAt",j.next_attempt_at AS "nextAttemptAt",j.completed_at AS "completedAt",j.cancel_requested_at AS "cancelRequestedAt",j.last_code AS "lastCode",j.message_id::text AS "messageId",j.payload,
        COALESCE((SELECT jsonb_agg(a ORDER BY a.number) FROM(SELECT number,state,code,started_at AS "startedAt",completed_at AS "completedAt",message_id::text AS "messageId" FROM notification_attempts WHERE tenant_id=j.tenant_id AND job_id=j.id ORDER BY number)a),'[]') AS history
        FROM notification_outbox j WHERE tenant_id=$1 ORDER BY j.created_at DESC,j.id DESC LIMIT 26 OFFSET $2`,
        [tenantId, offset],
      ),
      this.pool.query(
        "SELECT actor,action,revision::text,created_at AS at FROM notification_events WHERE tenant_id=$1 ORDER BY created_at DESC,id DESC LIMIT 20",
        [tenantId],
      ),
      this.pool.query("SELECT lifecycle FROM tenants WHERE id=$1", [tenantId]),
    ]);
    return {
      channel: channel.rows[0] ?? null,
      deliveries: jobs.rows.slice(0, 25),
      hasMore: jobs.rows.length > 25,
      offset,
      events: events.rows,
      lifecycle: tenant.rows[0]?.lifecycle,
      worker: this.status(),
    };
  }

  /** @param {{id:string,tenant_id:string,token_hash:string}} session @param {object} body @returns {Promise<void>} */
  async change(session, body) {
    if (
      !["save", "enable", "disable", "test"].includes(body.action) ||
      typeof body.revision !== "string" ||
      !/^\d{1,18}$/.test(body.revision)
    )
      throw new SecurityError(
        400,
        "Choose a valid notification action and revision",
      );
    if (
      body.action === "save" &&
      (!validTelegramChat(body.chatId) ||
        !["en", "bg"].includes(body.language) ||
        typeof body.botToken !== "string" ||
        (body.botToken !== "" && !validTelegramToken(body.botToken)))
    )
      throw new SecurityError(
        400,
        "Enter a valid Telegram bot token, numeric chat ID and notification language",
      );
    if (
      body.action === "test" &&
      (typeof body.requestId !== "string" || !UUID.test(body.requestId))
    )
      throw new SecurityError(
        400,
        "A unique notification test identifier is required",
      );
    const hash = await this.security.confirmedPassword(
      session.id,
      body.currentPassword,
    );
    let cancelled = false;
    await this.security.withUser(session.id, async (client, user) => {
      await this.security.activeSession(client, session);
      if (user.tenant_id !== session.tenant_id || user.password_hash !== hash)
        throw new SecurityError(
          409,
          "Your account changed. Refresh this page and try again.",
        );
      const tenant = (
        await client.query(
          "SELECT lifecycle FROM tenants WHERE id=$1 FOR UPDATE",
          [session.tenant_id],
        )
      ).rows[0];
      if (!["active", "suspended"].includes(tenant?.lifecycle))
        throw new SecurityError(
          409,
          "This workspace is closing. Notification changes are unavailable.",
        );
      let channel = (
        await client.query(
          "SELECT * FROM notification_channels WHERE tenant_id=$1 FOR UPDATE",
          [session.tenant_id],
        )
      ).rows[0];
      if (String(channel?.revision ?? 0) !== body.revision)
        throw new SecurityError(
          409,
          "Notification settings changed. Refresh before trying again.",
        );
      if (body.action === "save") {
        if (!channel && !body.botToken)
          throw new SecurityError(
            400,
            "Enter the Telegram bot token before saving",
          );
        const id = channel?.id ?? randomUUID();
        const changed =
          !channel ||
          channel.chat_id !== body.chatId ||
          channel.language !== body.language ||
          body.botToken !== "" ||
          channel.quarantined;
        if (!changed) return;
        const secret = body.botToken
          ? encryptNotificationSecret(
              body.botToken,
              this.hub.key,
              session.tenant_id,
              id,
            )
          : channel.secret;
        if (!secret)
          throw new SecurityError(
            409,
            "Save notification credentials before testing delivery",
          );
        channel = (
          await client.query(
            `INSERT INTO notification_channels(id,tenant_id,chat_id,secret,language) VALUES($1,$2,$3,$4,$5)
          ON CONFLICT(tenant_id) DO UPDATE SET chat_id=EXCLUDED.chat_id,secret=EXCLUDED.secret,language=EXCLUDED.language,enabled=false,quarantined=false,
          verified_at=null,blocked_code=null,platform_state=null,revision=notification_channels.revision+1,updated_at=clock_timestamp() RETURNING *`,
            [id, session.tenant_id, body.chatId, secret, body.language],
          )
        ).rows[0];
        cancelled = true;
        await recordChange(client, channel, user.email, "saved");
      } else {
        if (
          !channel ||
          (body.action !== "disable" &&
            (!channel.secret || channel.quarantined))
        )
          throw new SecurityError(
            409,
            "Save notification credentials before testing delivery",
          );
        if (body.action === "test") {
          const key = `test:${body.requestId}`;
          if (
            (
              await client.query(
                "SELECT 1 FROM notification_outbox WHERE channel_id=$1 AND channel_revision=$2 AND event_key=$3",
                [channel.id, channel.revision, key],
              )
            ).rowCount
          )
            return;
          if (
            channel.last_test_at &&
            Date.now() - new Date(channel.last_test_at).getTime() < 60000
          )
            throw new SecurityError(
              429,
              "Wait one minute before sending another notification test",
            );
          const id = randomUUID();
          await enqueue(client, channel, {
            id,
            eventKey: key,
            kind: "test",
            payload: testNotification(channel.language, this.origin, id),
          });
          await client.query(
            "UPDATE notification_channels SET last_test_at=clock_timestamp() WHERE id=$1",
            [channel.id],
          );
          await recordChange(client, channel, user.email, "test");
          return;
        }
        if (body.action === "enable" && !channel.verified_at)
          throw new SecurityError(
            409,
            "Confirm a delivered test before enabling notifications",
          );
        const enabled = body.action === "enable";
        if (channel.enabled === enabled && enabled) return;
        channel = (
          await client.query(
            "UPDATE notification_channels SET enabled=$2,revision=revision+1,platform_state=null,updated_at=clock_timestamp() WHERE id=$1 RETURNING *",
            [channel.id, enabled],
          )
        ).rows[0];
        await recordChange(
          client,
          channel,
          user.email,
          enabled ? "enabled" : "disabled",
        );
        cancelled = true;
      }
      if (cancelled) {
        await client.query(
          `UPDATE notification_outbox SET cancel_requested_at=COALESCE(cancel_requested_at,clock_timestamp()),state=CASE WHEN state='sending' THEN state ELSE 'cancelled' END,
          completed_at=CASE WHEN state='sending' THEN completed_at ELSE clock_timestamp() END,last_code='settings_changed'
          WHERE tenant_id=$1 AND state IN('queued','retry','sending')`,
          [session.tenant_id],
        );
      }
      if (channel.enabled) {
        const active = (
          await client.query(
            "SELECT * FROM operational_incidents WHERE tenant_id=$1 AND resolved_at IS NULL",
            [session.tenant_id],
          )
        ).rows;
        for (const incident of active)
          await this.capture(client, incident, "opened");
      }
    });
    if (cancelled) await this.cancelTenant(session.tenant_id);
  }

  /** @param {import('pg').PoolClient} client @param {object} incident @param {'opened'|'escalated'|'resolved'} kind @returns {Promise<void>} */
  async capture(client, incident, kind) {
    const channel = (
      await client.query(
        "SELECT c.*,t.name FROM notification_channels c JOIN tenants t ON t.id=c.tenant_id WHERE c.tenant_id=$1 AND c.enabled AND NOT c.quarantined AND t.lifecycle IN('active','suspended') FOR UPDATE OF c",
        [incident.tenant_id],
      )
    ).rows[0];
    if (!channel) return;
    const id = randomUUID();
    const payload = incidentNotification(incident, kind, {
      language: channel.language,
      name: channel.name,
      origin: this.origin,
      reference: id,
    });
    await enqueue(client, channel, {
      id,
      kind,
      incidentId: incident.id,
      eventKey: `${incident.id}:${incident.revision}:${kind}`,
      payload,
    });
  }

  /** @param {boolean} [restarting] @returns {Promise<number>} */
  async recoverSending(restarting = false) {
    const code = restarting ? "service_restarted" : "result_not_saved";
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const jobs = (
        await client.query(
          "SELECT id,tenant_id FROM notification_outbox WHERE state='sending' ORDER BY created_at LIMIT 100 FOR UPDATE SKIP LOCKED",
        )
      ).rows;
      for (const job of jobs) {
        await client.query(
          "UPDATE notification_attempts SET state='unconfirmed',code=$3,completed_at=clock_timestamp() WHERE tenant_id=$1 AND job_id=$2 AND state='sending'",
          [job.tenant_id, job.id, code],
        );
        await client.query(
          `UPDATE notification_outbox j SET had_unconfirmed=true,last_code=$2,
          state=CASE WHEN cancel_requested_at IS NOT NULL OR NOT EXISTS(SELECT 1 FROM notification_channels c JOIN tenants t ON t.id=c.tenant_id WHERE c.id=j.channel_id AND c.revision=j.channel_revision AND NOT c.quarantined AND(c.enabled OR j.kind='test') AND t.lifecycle IN('active','suspended')) THEN 'cancelled' WHEN attempts>=4 OR created_at<clock_timestamp()-interval '23 hours 59 minutes' THEN 'unconfirmed' ELSE 'retry' END,
          next_attempt_at=clock_timestamp()+interval '1 minute',completed_at=CASE WHEN attempts>=4 OR cancel_requested_at IS NOT NULL THEN clock_timestamp() ELSE null END
          WHERE id=$1`,
          [job.id, code],
        );
        await client.query(
          "UPDATE notification_outbox SET completed_at=clock_timestamp() WHERE id=$1 AND state IN('cancelled','unconfirmed') AND completed_at IS NULL",
          [job.id],
        );
        await client.query(
          "UPDATE notification_outbox SET completed_at=CASE WHEN state='retry' THEN null ELSE clock_timestamp() END WHERE id=$1",
          [job.id],
        );
      }
      await client.query("COMMIT");
      return jobs.length;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /** @returns {Promise<object|null>} */
  async claim() {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout='200ms'");
      await client.query("SET LOCAL statement_timeout='2s'");
      const candidate = (
        await client.query(`SELECT j.id,j.tenant_id,j.channel_id FROM notification_outbox j JOIN tenants t ON t.id=j.tenant_id
        WHERE j.state IN('queued','retry') AND j.next_attempt_at<=clock_timestamp()
        ORDER BY j.next_attempt_at,j.created_at,j.id LIMIT 1 FOR SHARE OF t SKIP LOCKED`)
      ).rows[0];
      if (!candidate) {
        await client.query("COMMIT");
        return null;
      }
      const channel = (
        await client.query(
          "SELECT * FROM notification_channels WHERE id=$1 FOR UPDATE",
          [candidate.channel_id],
        )
      ).rows[0];
      const job = (
        await client.query(
          "SELECT j.*,t.lifecycle FROM notification_outbox j JOIN tenants t ON t.id=j.tenant_id WHERE j.id=$1 AND j.state IN('queued','retry') FOR UPDATE OF j SKIP LOCKED",
          [candidate.id],
        )
      ).rows[0];
      if (!job) {
        await client.query("COMMIT");
        return null;
      }
      const cancelled =
        !["active", "suspended"].includes(job.lifecycle) ||
        channel.quarantined ||
        String(channel.revision) !== String(job.channel_revision) ||
        job.cancel_requested_at ||
        (!channel.enabled && job.kind !== "test");
      const expired =
        Date.now() - new Date(job.created_at).getTime() > 86400000 ||
        job.attempts >= 4;
      if (cancelled || expired) {
        await client.query(
          "UPDATE notification_outbox SET state=$2,last_code=$3,completed_at=clock_timestamp() WHERE id=$1",
          [
            job.id,
            cancelled
              ? "cancelled"
              : job.had_unconfirmed
                ? "unconfirmed"
                : "failed",
            cancelled ? "settings_changed" : "delivery_expired",
          ],
        );
        await client.query("COMMIT");
        return null;
      }
      const attempt = randomUUID();
      await client.query(
        "UPDATE notification_outbox SET state='sending',attempts=attempts+1 WHERE id=$1",
        [job.id],
      );
      await client.query(
        "INSERT INTO notification_attempts(id,tenant_id,job_id,number) VALUES($1,$2,$3,$4)",
        [attempt, job.tenant_id, job.id, job.attempts + 1],
      );
      await client.query("COMMIT");
      return {
        ...job,
        attempts: job.attempts + 1,
        attemptId: attempt,
        channel,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /** @param {object} job @param {import('./telegram.mjs').DeliveryResult} result @returns {Promise<void>} */
  async finish(job, result) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout='2s'");
      await client.query("SELECT id FROM tenants WHERE id=$1 FOR SHARE", [
        job.tenant_id,
      ]);
      const channel = (
        await client.query(
          "SELECT c.*,t.lifecycle FROM notification_channels c JOIN tenants t ON t.id=c.tenant_id WHERE c.id=$1 FOR UPDATE OF c",
          [job.channel_id],
        )
      ).rows[0];
      const row = (
        await client.query(
          "SELECT * FROM notification_outbox WHERE id=$1 AND state='sending' FOR UPDATE",
          [job.id],
        )
      ).rows[0];
      if (!row) {
        await client.query("ROLLBACK");
        return;
      }
      const delivered = result.state === "delivered";
      const uncertain = result.state === "unconfirmed";
      const cancelled =
        result.state === "cancelled" ||
        row.cancel_requested_at ||
        !channel ||
        channel.quarantined ||
        String(channel.revision) !== String(job.channel_revision) ||
        !["active", "suspended"].includes(channel.lifecycle) ||
        (!channel.enabled && job.kind !== "test");
      const seconds =
        ("retryAfter" in result ? result.retryAfter : undefined) ??
        RETRY_SECONDS[job.attempts - 1] ??
        900;
      const withinDeadline =
        Date.now() + seconds * 1000 <
        new Date(job.created_at).getTime() + 86400000;
      const retryCandidate =
        !delivered &&
        !cancelled &&
        ["retry", "unconfirmed"].includes(result.state) &&
        job.attempts < 4;
      const retry = retryCandidate && withinDeadline;
      const code =
        retryCandidate && !withinDeadline
          ? "retry_after_deadline"
          : result.code;
      const state = delivered
        ? "delivered"
        : cancelled
          ? "cancelled"
          : retry
            ? "retry"
            : uncertain || row.had_unconfirmed
              ? "unconfirmed"
              : "failed";
      const messageId = delivered ? result.messageId : null;
      await client.query(
        "UPDATE notification_attempts SET state=$2,code=$3,completed_at=clock_timestamp(),message_id=$4 WHERE id=$1 AND state='sending'",
        [
          job.attemptId,
          delivered
            ? "delivered"
            : uncertain
              ? "unconfirmed"
              : result.state === "cancelled"
                ? "cancelled"
                : "rejected",
          result.code,
          messageId,
        ],
      );
      await client.query(
        "UPDATE notification_outbox SET state=$2,last_code=$3,had_unconfirmed=had_unconfirmed OR $4,next_attempt_at=clock_timestamp()+$5*interval '1 second',completed_at=CASE WHEN $2='retry' THEN null ELSE clock_timestamp() END,message_id=$6 WHERE id=$1",
        [job.id, state, code, uncertain, seconds, messageId],
      );
      if (delivered && job.kind === "test" && !cancelled)
        await client.query(
          "UPDATE notification_channels SET verified_at=clock_timestamp(),blocked_code=null WHERE id=$1 AND revision=$2 AND NOT quarantined",
          [job.channel_id, job.channel_revision],
        );
      if (
        !cancelled &&
        result.state === "rejected" &&
        [
          "bot_unauthorized",
          "destination_rejected",
          "credentials_unavailable",
          "invalid_configuration",
        ].includes(result.code)
      ) {
        const blocked = (
          await client.query(
            "UPDATE notification_channels SET enabled=false,verified_at=null,blocked_code=$2,revision=revision+1,platform_state=null,updated_at=clock_timestamp() WHERE id=$1 AND revision=$3 RETURNING *",
            [job.channel_id, result.code, job.channel_revision],
          )
        ).rows[0];
        if (blocked) {
          await recordChange(client, blocked, "System", "blocked");
          await client.query(
            "UPDATE notification_outbox SET state='cancelled',cancel_requested_at=clock_timestamp(),last_code='settings_changed',completed_at=clock_timestamp() WHERE channel_id=$1 AND state IN('queued','retry')",
            [job.channel_id],
          );
        }
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /** @returns {Promise<void>} */
  runOnce() {
    if (this.pending) return this.pending;
    if (this.stopping || this.hub.stopping) return Promise.resolve();
    this.pending = (async () => {
      await this.recoverSending();
      if (Date.now() - this.platformAt > 60000) {
        await this.capturePlatform();
        this.platformAt = Date.now();
      }
      const job = await this.claim();
      if (job) {
        const abort = new AbortController();
        this.inFlight = { tenantId: job.tenant_id, abort };
        /** @type {import('./telegram.mjs').DeliveryResult} */
        let result = { state: "retry", code: "dispatch_check_failed" };
        let dispatched = false;
        try {
          const allowed = (
            await this.pool.query(
              `SELECT 1 FROM notification_outbox j JOIN notification_channels c ON c.id=j.channel_id JOIN tenants t ON t.id=j.tenant_id
            WHERE j.id=$1 AND j.state='sending' AND j.cancel_requested_at IS NULL AND c.revision=j.channel_revision AND NOT c.quarantined AND c.secret IS NOT NULL AND(c.enabled OR j.kind='test') AND t.lifecycle IN('active','suspended')`,
              [job.id],
            )
          ).rowCount;
          if (
            !allowed ||
            abort.signal.aborted ||
            this.stopping ||
            this.hub.stopping
          )
            result = { state: "cancelled", code: "cancelled_before_dispatch" };
          else {
            let secret = null;
            try {
              secret = decryptNotificationSecret(
                job.channel.secret,
                this.hub.key,
                job.tenant_id,
                job.channel_id,
              );
            } catch {
              result = { state: "rejected", code: "credentials_unavailable" };
            }
            if (secret) {
              dispatched = true;
              result = await this.send({
                botToken: secret.botToken,
                chatId: job.channel.chat_id,
                text: job.payload.text,
                signal: abort.signal,
              });
            }
          }
        } catch {
          result = dispatched
            ? { state: "unconfirmed", code: "delivery_unconfirmed" }
            : { state: "retry", code: "dispatch_check_failed" };
        }
        await this.finish(job, result);
        this.inFlight = null;
      }
      this.checkedAt = Date.now();
    })().finally(() => {
      this.pending = null;
      this.inFlight = null;
    });
    return this.pending;
  }

  /** @param {string} tenantId @returns {Promise<void>} */
  async cancelTenant(tenantId) {
    if (this.inFlight?.tenantId !== tenantId) return;
    this.inFlight.abort.abort();
    await this.pending?.catch(() => {});
  }

  /** @returns {Promise<void>} */
  async capturePlatform() {
    const backup = await readBackupStatus(
      this.hub.env.BACKUP_STATUS_FILE ??
        "/var/lib/solarman-backup/public/status.json",
    );
    const erasure = await this.hub.offboarding.serviceStatus();
    const issues = [
      !["healthy", "running"].includes(backup.state) &&
        `backup:${backup.state}`,
      erasure.state !== "verified" && `erasure:${erasure.state}`,
      this.hub.operations.status().state === "delayed" && "monitor:delayed",
    ].filter(Boolean);
    const fingerprint = issues.length ? issues.join("|") : "healthy";
    const candidates = (
      await this.pool.query(
        "SELECT c.id,c.tenant_id FROM notification_channels c JOIN tenants t ON t.id=c.tenant_id WHERE c.enabled AND NOT c.quarantined AND t.lifecycle IN('active','suspended') AND EXISTS(SELECT 1 FROM users u WHERE u.tenant_id=c.tenant_id AND u.platform_admin) AND c.platform_state IS DISTINCT FROM $1 ORDER BY c.updated_at LIMIT 10",
        [fingerprint],
      )
    ).rows;
    for (const candidate of candidates) {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL lock_timeout='200ms'");
        await client.query("SELECT id FROM tenants WHERE id=$1 FOR SHARE", [
          candidate.tenant_id,
        ]);
        const channel = (
          await client.query(
            "SELECT * FROM notification_channels WHERE id=$1 AND enabled AND NOT quarantined FOR UPDATE",
            [candidate.id],
          )
        ).rows[0];
        if (!channel || channel.platform_state === fingerprint) {
          await client.query("COMMIT");
          continue;
        }
        const initialHealthy =
          channel.platform_state === null && fingerprint === "healthy";
        const next = (
          await client.query(
            "UPDATE notification_channels SET platform_state=$2,platform_sequence=platform_sequence+1 WHERE id=$1 RETURNING *",
            [channel.id, fingerprint],
          )
        ).rows[0];
        if (!initialHealthy) {
          const id = randomUUID(),
            bg = channel.language === "bg";
          const title =
            fingerprint === "healthy"
              ? bg
                ? "Платформата е възстановена"
                : "Platform recovery detected"
              : bg
                ? "Платформата изисква внимание"
                : "Platform needs attention";
          const descriptions = issues.map((issue) =>
            issue.startsWith("backup:")
              ? bg
                ? "Архивирането или проверката за възстановяване изискват внимание."
                : "Backup or recovery checks need attention."
              : issue.startsWith("erasure:")
                ? bg
                  ? "Потвържденията за изтриване са остарели или недостъпни."
                  : "Erasure recovery receipts are overdue or unavailable."
                : bg
                  ? "Оперативното наблюдение закъснява."
                  : "The operational monitor is overdue.",
          );
          await enqueue(client, next, {
            id,
            kind: "platform",
            eventKey: `platform:${next.platform_sequence}`,
            payload: {
              title,
              text: [
                "SOLARMAN · " + title,
                ...descriptions,
                new Date().toISOString(),
                `${this.origin}/settings/health`,
                (bg ? "Номер на събитието: " : "Event reference: ") + id,
              ].join("\n"),
            },
          });
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        if (error?.code !== "55P03") throw error;
      } finally {
        client.release();
      }
    }
  }

  /** @returns {void} */
  start() {
    if (this.startedAt !== null || this.stopping) return;
    this.startedAt = Date.now();
    const tick = async () => {
      if (this.stopping) return;
      try {
        await this.runOnce();
      } catch {
        console.error(JSON.stringify({ event: "notification_worker_failed" }));
      }
      if (!this.stopping)
        this.timer = setTimeout(() => {
          void tick();
        }, 5000);
    };
    void tick();
  }
  /** @returns {Promise<void>} */
  async stop() {
    this.stopping = true;
    clearTimeout(this.timer);
    this.inFlight?.abort.abort();
    await this.pending?.catch(() => {});
  }
}
