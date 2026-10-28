import { AccountSecurity, SecurityError } from "./account-security.mjs";

export const SUSPENDED_MESSAGE =
  "This workspace is suspended. New automation and administration are unavailable.";

/** @param {import('pg').PoolClient} client @param {string} tenantId @returns {Promise<void>} */
export async function requireActiveTenant(client, tenantId) {
  const row = (
    await client.query("SELECT lifecycle FROM tenants WHERE id=$1 FOR SHARE", [
      tenantId,
    ])
  ).rows[0];
  if (row?.lifecycle !== "active")
    throw new SecurityError(409, SUSPENDED_MESSAGE);
}

export class TenantLifecycle {
  /** @param {import('pg').Pool} pool */
  constructor(pool) {
    this.pool = pool;
    this.security = new AccountSecurity(pool);
  }

  /** @param {string} tenantId @returns {Promise<object>} */
  async status(tenantId) {
    const row = (
      await this.pool.query(
        `SELECT t.lifecycle AS state,t.lifecycle_revision::text AS revision,t.lifecycle_changed_at AS "changedAt",t.lifecycle_message AS message,
      EXISTS (SELECT 1 FROM users u WHERE u.tenant_id=t.id AND u.platform_admin) AS protected,
      EXISTS (SELECT 1 FROM device_control_state d WHERE d.tenant_id=t.id AND d.state IN ('uncertain','cleanup-required')) AS "cleanupPending",
      COALESCE((SELECT jsonb_agg(e ORDER BY e.revision::bigint DESC) FROM
        (SELECT id,revision::text,state,message,created_at AS at FROM tenant_lifecycle_events WHERE tenant_id=t.id ORDER BY tenant_lifecycle_events.revision DESC LIMIT 20) e),'[]'::jsonb) AS events
      FROM tenants t WHERE t.id=$1`,
        [tenantId],
      )
    ).rows[0];
    if (!row) throw new SecurityError(404, "Workspace not found");
    return row;
  }

  /** @param {{id:string,token_hash:string}} actor @param {string} tenantId @param {{state:unknown,revision:unknown,currentPassword:unknown,message:unknown}} body @returns {Promise<{changed:boolean,appKey:string|null}>} */
  async change(actor, tenantId, body) {
    if (
      !["active", "suspended"].includes(body.state) ||
      typeof body.revision !== "string" ||
      !/^\d{1,18}$/.test(body.revision) ||
      typeof body.message !== "string" ||
      body.message.length > 500
    )
      throw new SecurityError(
        400,
        "Choose a valid workspace state and message",
      );
    const hash = await this.security.confirmedPassword(
      actor.id,
      body.currentPassword,
    );
    return this.security.withUser(actor.id, async (client, user) => {
      await this.security.activeSession(client, actor);
      if (!user.platform_admin)
        throw new SecurityError(403, "Administrator access is required");
      if (user.password_hash !== hash)
        throw new SecurityError(
          409,
          "Your account changed. Refresh this page and try again.",
        );
      // Reject administrator targets before taking their tenant lock; two admins must not cross-lock each other.
      if (
        (
          await client.query(
            "SELECT 1 FROM users WHERE tenant_id=$1 AND platform_admin",
            [tenantId],
          )
        ).rowCount
      )
        throw new SecurityError(
          409,
          "Administrator workspace availability is managed by the server operator",
        );
      await requireActiveTenant(client, user.tenant_id);
      const account = (
        await client.query(
          "SELECT api_app_key FROM solarman_accounts WHERE tenant_id=$1",
          [tenantId],
        )
      ).rows[0];
      const appKey = account?.api_app_key ?? null;
      // Match capacity activation's lock order; the controller row serializes starts and suspension.
      if (appKey)
        await client.query(
          "SELECT app_key FROM api_app_budgets WHERE app_key=$1 FOR UPDATE",
          [appKey],
        );
      const control = (
        await client.query(
          "SELECT control_enabled FROM controller_state WHERE tenant_id=$1 FOR UPDATE",
          [tenantId],
        )
      ).rows[0];
      const tenant = (
        await client.query(
          "SELECT lifecycle,lifecycle_revision::text AS revision FROM tenants WHERE id=$1 FOR UPDATE",
          [tenantId],
        )
      ).rows[0];
      if (!tenant || !control)
        throw new SecurityError(404, "Workspace not found");
      if (
        (
          await client.query(
            "SELECT 1 FROM users WHERE tenant_id=$1 AND platform_admin",
            [tenantId],
          )
        ).rowCount
      )
        throw new SecurityError(
          409,
          "Administrator workspace availability is managed by the server operator",
        );
      if (tenant.revision !== body.revision)
        throw new SecurityError(
          409,
          "Workspace state changed. Refresh before making another change.",
        );
      if (tenant.lifecycle === body.state) return { changed: false, appKey };
      await client.query(
        `UPDATE controller_state SET paused=true,manual_topup=false,topup_expires_at=null,control_enabled=false,verification=null,control_epoch=control_epoch+1,updated_at=now() WHERE tenant_id=$1`,
        [tenantId],
      );
      await client.query(
        "UPDATE device_control_state SET state='cleanup-required',updated_at=now() WHERE tenant_id=$1 AND state<>'clear'",
        [tenantId],
      );
      if (control.control_enabled)
        await client.query(
          `INSERT INTO device_control_state (tenant_id,account_id,device,state)
        SELECT tenant_id,id,device_sn,'cleanup-required' FROM solarman_accounts WHERE tenant_id=$1 AND device_sn IS NOT NULL
        ON CONFLICT (tenant_id,account_id,device) DO UPDATE SET state='cleanup-required',updated_at=now()`,
          [tenantId],
        );
      await client.query(
        "UPDATE command_executions SET status='interrupted',message='Control request cancelled; workspace state changed',completed_at=now() WHERE tenant_id=$1 AND action IN ('resume','topup','enable_controls') AND status='queued'",
        [tenantId],
      );
      if (body.state === "suspended")
        await client.query(
          "UPDATE invitations SET revoked_at=clock_timestamp(),revoked_by=$2 WHERE created_by IN (SELECT id FROM users WHERE tenant_id=$1) AND used_at IS NULL AND revoked_at IS NULL",
          [tenantId, user.id],
        );
      const message = body.message.trim();
      const updated = (
        await client.query(
          `UPDATE tenants SET lifecycle=$2,lifecycle_revision=lifecycle_revision+1,lifecycle_changed_at=clock_timestamp(),lifecycle_message=$3 WHERE id=$1 RETURNING lifecycle_revision`,
          [tenantId, body.state, message],
        )
      ).rows[0];
      await client.query(
        "INSERT INTO tenant_lifecycle_events (tenant_id,revision,state,message,actor_id) VALUES ($1,$2,$3,$4,$5)",
        [tenantId, updated.lifecycle_revision, body.state, message, user.id],
      );
      return { changed: true, appKey };
    });
  }
}
