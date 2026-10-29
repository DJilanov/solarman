import { createHash, randomUUID } from "node:crypto";
import { AccountSecurity, SecurityError } from "./account-security.mjs";
import {
  normalizePushSubscription,
  pushEndpointHash,
  encryptPushSubscription,
  webPushConfiguration,
} from "./web-push.mjs";
import {
  enqueueNotification,
  recordNotificationChange,
} from "./notification-store.mjs";
import { testNotification } from "./notification-messages.mjs";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

export class PushSubscriptions {
  /** @param {import('pg').Pool} pool @param {object} hub @param {object} notifications */
  constructor(pool, hub, notifications) {
    this.pool = pool;
    this.hub = hub;
    this.notifications = notifications;
    this.security = new AccountSecurity(pool);
    this.configuration = webPushConfiguration(hub.env);
  }

  /** @param {{id:string,tenant_id:string}} session @returns {Promise<object>} */
  async settings(session) {
    const [devices, tenant] = await Promise.all([
      this.pool.query(
        `SELECT c.id,c.chat_id AS label,c.endpoint_hash AS "endpointHash",c.language,c.enabled,c.quarantined,
        c.push_enable_pending AS pending,c.revision::text,c.verified_at AS "verifiedAt",c.last_test_at AS "lastTestAt",c.blocked_code AS "blockedCode",c.created_at AS "createdAt",
        (SELECT jsonb_build_object('id',j.id,'state',j.state,'code',j.last_code,'displayedAt',j.push_displayed_at)
        FROM notification_outbox j WHERE j.channel_id=c.id ORDER BY j.created_at DESC,j.id DESC LIMIT 1) AS "lastDelivery"
        FROM notification_channels c WHERE c.tenant_id=$1 AND c.user_id=$2 AND c.kind='webpush' AND c.revoked_at IS NULL
        ORDER BY c.created_at DESC,c.id LIMIT 10`,
        [session.tenant_id, session.id],
      ),
      this.pool.query("SELECT lifecycle FROM tenants WHERE id=$1", [
        session.tenant_id,
      ]),
    ]);
    return {
      configured: Boolean(this.configuration),
      publicKey: this.configuration?.publicKey ?? null,
      devices: devices.rows,
      lifecycle: tenant.rows[0]?.lifecycle,
    };
  }

  /** @param {{id:string,tenant_id:string,token_hash:string}} session @param {object} body @returns {Promise<void>} */
  async change(session, body) {
    if (
      !["subscribe", "revoke", "test"].includes(body.action) ||
      (body.action !== "revoke" &&
        (typeof body.requestId !== "string" || !UUID.test(body.requestId))) ||
      (body.action !== "subscribe" &&
        (typeof body.id !== "string" || !UUID.test(body.id))) ||
      typeof body.revision !== "string" ||
      !/^\d{1,18}$/.test(body.revision)
    )
      throw new SecurityError(
        400,
        "Choose a valid browser notification action",
      );
    if (body.action !== "revoke" && !this.configuration)
      throw new SecurityError(
        409,
        "Browser notifications are not configured on the server",
      );
    let subscription;
    let fingerprint;
    if (body.action === "subscribe") {
      try {
        subscription = normalizePushSubscription(body.subscription);
      } catch {
        throw new SecurityError(
          400,
          "Browser push subscription is invalid or unsupported",
        );
      }
      if (
        !["en", "bg"].includes(body.language) ||
        typeof body.label !== "string" ||
        !body.label.trim() ||
        body.label.length > 80 ||
        /[\u0000-\u001f\u007f]/.test(body.label)
      )
        throw new SecurityError(
          400,
          "Choose a device name and notification language",
        );
      fingerprint = createHash("sha256")
        .update(
          JSON.stringify([subscription, body.label.trim(), body.language]),
        )
        .digest("hex");
    }
    const hash = await this.security.confirmedPassword(
      session.id,
      body.currentPassword,
    );
    let changedChannel;
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
      let channel;
      if (body.action === "subscribe") {
        const endpointHash = pushEndpointHash(subscription);
        channel = (
          await client.query(
            "SELECT * FROM notification_channels WHERE endpoint_hash=$1 FOR UPDATE",
            [endpointHash],
          )
        ).rows[0];
        if (
          channel &&
          (channel.tenant_id !== session.tenant_id ||
            channel.user_id !== session.id)
        )
          throw new SecurityError(
            409,
            "Recreate this browser subscription before linking it to another account",
          );
        if (channel?.push_request_id === body.requestId) {
          if (channel.push_request_hash !== fingerprint)
            throw new SecurityError(
              409,
              "The browser notification request changed. Refresh before trying again.",
            );
          return;
        }
        if (
          String(channel?.revision ?? 0) !== body.revision &&
          !(channel?.revoked_at && body.revision === "0")
        )
          throw new SecurityError(
            409,
            "Notification settings changed. Refresh before trying again.",
          );
        if (!channel || channel.revoked_at) {
          const count = (
            await client.query(
              "SELECT count(*)::int AS n FROM notification_channels WHERE tenant_id=$1 AND kind='webpush' AND revoked_at IS NULL",
              [session.tenant_id],
            )
          ).rows[0].n;
          if (count >= 10)
            throw new SecurityError(
              409,
              "Remove an old browser subscription before adding another device",
            );
        }
        if (!channel) {
          const recent = (
            await client.query(
              "SELECT count(*)::int AS n FROM notification_channels WHERE tenant_id=$1 AND kind='webpush' AND created_at>clock_timestamp()-interval '24 hours'",
              [session.tenant_id],
            )
          ).rows[0].n;
          if (recent >= 50)
            throw new SecurityError(
              429,
              "Too many new browser subscriptions. Try again after 24 hours.",
            );
        }
        const id = channel?.id ?? randomUUID();
        const secret = encryptPushSubscription(
          subscription,
          this.hub.key,
          session.tenant_id,
          id,
        );
        channel = (
          await client.query(
            `INSERT INTO notification_channels(id,tenant_id,kind,user_id,endpoint_hash,chat_id,secret,language,push_enable_pending,push_request_id,push_request_hash)
          VALUES($1,$2,'webpush',$3,$4,$5,$6,$7,true,$8,$9)
          ON CONFLICT(id) DO UPDATE SET chat_id=EXCLUDED.chat_id,secret=EXCLUDED.secret,language=EXCLUDED.language,
          enabled=false,quarantined=false,verified_at=null,blocked_code=null,platform_state=null,revoked_at=null,push_enable_pending=true,
          push_request_id=EXCLUDED.push_request_id,push_request_hash=EXCLUDED.push_request_hash,
          revision=notification_channels.revision+1,updated_at=clock_timestamp() RETURNING *`,
            [
              id,
              session.tenant_id,
              session.id,
              endpointHash,
              body.label.trim(),
              secret,
              body.language,
              body.requestId,
              fingerprint,
            ],
          )
        ).rows[0];
        await recordNotificationChange(client, channel, user.email, "saved");
        changedChannel = channel;
      } else {
        channel = (
          await client.query(
            "SELECT * FROM notification_channels WHERE id=$1 AND tenant_id=$2 AND user_id=$3 AND kind='webpush' FOR UPDATE",
            [body.id, session.tenant_id, session.id],
          )
        ).rows[0];
        if (!channel || String(channel.revision) !== body.revision)
          throw new SecurityError(
            409,
            "Notification settings changed. Refresh before trying again.",
          );
        if (body.action === "revoke") {
          channel = (
            await client.query(
              "UPDATE notification_channels SET enabled=false,push_enable_pending=false,secret=null,verified_at=null,quarantined=true,revoked_at=clock_timestamp(),revision=revision+1,updated_at=clock_timestamp() WHERE id=$1 RETURNING *",
              [channel.id],
            )
          ).rows[0];
          changedChannel = channel;
          await recordNotificationChange(
            client,
            channel,
            user.email,
            "disabled",
          );
        } else if (
          !channel.secret ||
          channel.quarantined ||
          channel.revoked_at
        ) {
          throw new SecurityError(
            409,
            "Enable browser notifications again before testing this device",
          );
        }
      }
      if (changedChannel)
        await client.query(
          `UPDATE notification_outbox SET cancel_requested_at=COALESCE(cancel_requested_at,clock_timestamp()),
        state=CASE WHEN state='sending' THEN state ELSE 'cancelled' END,
        completed_at=CASE WHEN state='sending' THEN completed_at ELSE clock_timestamp() END,last_code='settings_changed'
        WHERE channel_id=$1 AND channel_revision<>$2 AND state IN('queued','retry','sending')`,
          [channel.id, channel.revision],
        );
      if (body.action === "revoke") return;
      const eventKey = `test:${body.requestId}`;
      if (
        (
          await client.query(
            "SELECT 1 FROM notification_outbox WHERE channel_id=$1 AND event_key=$2",
            [channel.id, eventKey],
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
      const jobId = randomUUID();
      await enqueueNotification(client, channel, {
        id: jobId,
        eventKey,
        kind: "test",
        payload: testNotification(
          channel.language,
          this.notifications.origin,
          jobId,
        ),
      });
      await client.query(
        "UPDATE notification_channels SET last_test_at=clock_timestamp() WHERE id=$1",
        [channel.id],
      );
      await recordNotificationChange(client, channel, user.email, "test");
    });
    if (changedChannel)
      await this.notifications.cancelChannel(
        session.tenant_id,
        changedChannel.id,
        String(changedChannel.revision),
      );
  }

  /** @param {object} body @returns {Promise<boolean>} */
  async receipt(body) {
    if (
      typeof body.id !== "string" ||
      !UUID.test(body.id) ||
      typeof body.attempt !== "string" ||
      !UUID.test(body.attempt) ||
      typeof body.token !== "string" ||
      !/^[a-f0-9]{64}$/.test(body.token)
    )
      throw new SecurityError(400, "Invalid browser notification receipt");
    const tokenHash = createHash("sha256").update(body.token).digest("hex");
    const target = (
      await this.pool.query(
        "SELECT j.tenant_id,j.channel_id FROM notification_attempts a JOIN notification_outbox j ON j.id=a.job_id WHERE a.id=$1 AND a.job_id=$2 AND a.push_receipt_hash=$3",
        [body.attempt, body.id, tokenHash],
      )
    ).rows[0];
    if (!target) return false;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const tenant = (
        await client.query(
          "SELECT name,lifecycle FROM tenants WHERE id=$1 FOR SHARE",
          [target.tenant_id],
        )
      ).rows[0];
      let channel = (
        await client.query(
          "SELECT * FROM notification_channels WHERE id=$1 FOR UPDATE",
          [target.channel_id],
        )
      ).rows[0];
      const job = (
        await client.query(
          "SELECT * FROM notification_outbox WHERE id=$1 FOR UPDATE",
          [body.id],
        )
      ).rows[0];
      if (
        !tenant ||
        !["active", "suspended"].includes(tenant.lifecycle) ||
        !channel ||
        !job ||
        channel.kind !== "webpush" ||
        channel.quarantined ||
        channel.revoked_at ||
        String(channel.revision) !== String(job?.channel_revision) ||
        job.cancel_requested_at ||
        Date.now() - new Date(job.created_at).getTime() > 86400000 ||
        (!channel.enabled && !channel.push_enable_pending)
      ) {
        await client.query("ROLLBACK");
        return false;
      }
      const consumed = await client.query(
        "UPDATE notification_attempts SET push_receipt_hash=null,push_displayed_at=clock_timestamp(),state='delivered',code='push_displayed',completed_at=COALESCE(completed_at,clock_timestamp()) WHERE id=$1 AND job_id=$2 AND push_receipt_hash=$3 RETURNING id",
        [body.attempt, body.id, tokenHash],
      );
      if (!consumed.rowCount) {
        await client.query("ROLLBACK");
        return false;
      }
      await client.query(
        `UPDATE notification_outbox SET push_displayed_at=COALESCE(push_displayed_at,clock_timestamp()),last_code='push_displayed',
        state=CASE WHEN state='sending' THEN state ELSE 'delivered' END,
        completed_at=CASE WHEN state='sending' THEN completed_at ELSE clock_timestamp() END WHERE id=$1`,
        [job.id],
      );
      if (job.kind === "test" && channel.push_enable_pending) {
        channel = (
          await client.query(
            "UPDATE notification_channels SET verified_at=clock_timestamp(),enabled=true,push_enable_pending=false,blocked_code=null,updated_at=clock_timestamp() WHERE id=$1 RETURNING *",
            [channel.id],
          )
        ).rows[0];
        await recordNotificationChange(client, channel, "System", "enabled");
        const incidents = (
          await client.query(
            "SELECT * FROM operational_incidents WHERE tenant_id=$1 AND resolved_at IS NULL",
            [target.tenant_id],
          )
        ).rows;
        for (const incident of incidents)
          await this.notifications.captureForChannel(
            client,
            { ...channel, name: tenant.name },
            incident,
            "opened",
          );
      }
      await client.query("COMMIT");
      return true;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
