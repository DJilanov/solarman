import { AccountSecurity, SecurityError } from "./account-security.mjs";
import {
  quarantineWorkspace,
  requireActiveTenant,
} from "./tenant-lifecycle.mjs";
import {
  readErasureGuard,
  ErasureGuardError,
  ERASURE_MAX_AGE_MS,
} from "./erasure-guard.mjs";
import { randomUUID } from "node:crypto";
import { unsigned32 } from "./modbus.mjs";

const LIMIT = 500;
const ERASE = {
  writes: `DELETE FROM inverter_write_intents WHERE id IN(SELECT id FROM inverter_write_intents WHERE tenant_id=$1 LIMIT ${LIMIT})`,
  commands: `DELETE FROM command_executions WHERE id IN(SELECT c.id FROM command_executions c WHERE c.tenant_id=$1 AND NOT EXISTS(SELECT 1 FROM inverter_write_intents w WHERE w.tenant_id=$1 AND w.execution_id=c.id) LIMIT ${LIMIT})`,
  measurements: `DELETE FROM measurements WHERE id IN(SELECT id FROM measurements WHERE tenant_id=$1 LIMIT ${LIMIT})`,
  provider: `DELETE FROM provider_readings WHERE id IN(SELECT id FROM provider_readings WHERE tenant_id=$1 LIMIT ${LIMIT})`,
  incidents: `DELETE FROM operational_incidents WHERE id IN(SELECT id FROM operational_incidents WHERE tenant_id=$1 LIMIT ${LIMIT})`,
  health: `DELETE FROM device_health WHERE (tenant_id,account_id,device) IN(SELECT tenant_id,account_id,device FROM device_health WHERE tenant_id=$1 LIMIT ${LIMIT})`,
  security: `DELETE FROM account_security_events WHERE id IN(SELECT id FROM account_security_events WHERE tenant_id=$1 LIMIT ${LIMIT})`,
  recovery: `DELETE FROM account_recovery_tokens WHERE id IN(SELECT r.id FROM account_recovery_tokens r JOIN users u ON u.id=r.user_id WHERE u.tenant_id=$1 LIMIT ${LIMIT})`,
  receipts: `DELETE FROM command_receipts WHERE (tenant_id,user_id,idempotency_key) IN(SELECT tenant_id,user_id,idempotency_key FROM command_receipts WHERE tenant_id=$1 LIMIT ${LIMIT})`,
  sessions: `DELETE FROM sessions WHERE id IN(SELECT s.id FROM sessions s JOIN users u ON u.id=s.user_id WHERE u.tenant_id=$1 LIMIT ${LIMIT})`,
  accounting: `UPDATE api_requests SET tenant_id=null,account_id=null WHERE id IN(SELECT id FROM api_requests WHERE tenant_id=$1 LIMIT ${LIMIT})`,
  history: `DELETE FROM tenant_lifecycle_events WHERE id IN(SELECT id FROM tenant_lifecycle_events WHERE tenant_id=$1 LIMIT ${LIMIT})`,
  policies: `DELETE FROM retention_policy_events WHERE id IN(SELECT id FROM retention_policy_events WHERE tenant_id=$1 LIMIT ${LIMIT})`,
  ownership: `DELETE FROM device_control_state WHERE(tenant_id,account_id,device) IN(SELECT d.tenant_id,d.account_id,d.device FROM device_control_state d WHERE d.tenant_id=$1 AND d.state='clear' AND NOT EXISTS(SELECT 1 FROM inverter_write_intents w WHERE w.tenant_id=d.tenant_id AND w.account_id=d.account_id AND w.device=d.device) LIMIT ${LIMIT})`,
};

/** @param {import('pg').PoolClient|import('pg').Pool} client @param {string} tenantId @returns {Promise<boolean>} */
export async function unresolvedCleanup(client, tenantId) {
  return (
    await client.query(
      `SELECT EXISTS(SELECT 1 FROM device_control_state WHERE tenant_id=$1 AND state<>'clear') OR EXISTS(SELECT 1 FROM inverter_write_intents WHERE tenant_id=$1 AND status<>'verified' AND reconciled_at IS NULL) OR EXISTS(SELECT 1 FROM command_executions WHERE tenant_id=$1 AND status IN('queued','running')) AS pending`,
      [tenantId],
    )
  ).rows[0].pending;
}

/** @param {import('pg').PoolClient} client @param {string} tenantId @returns {Promise<void>} */
async function revokeAccess(client, tenantId) {
  await client.query(
    "UPDATE solarman_accounts SET monitoring_admitted=false WHERE tenant_id=$1",
    [tenantId],
  );
  await client.query(
    "DELETE FROM sessions WHERE user_id IN(SELECT id FROM users WHERE tenant_id=$1)",
    [tenantId],
  );
  await client.query(
    "UPDATE account_recovery_tokens SET revoked_at=clock_timestamp() WHERE user_id IN(SELECT id FROM users WHERE tenant_id=$1) AND used_at IS NULL AND revoked_at IS NULL",
    [tenantId],
  );
  await client.query(
    "UPDATE workspace_retention SET enabled=false,revision=revision+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND enabled",
    [tenantId],
  );
  await client.query(
    `UPDATE invitations SET revoked_at=clock_timestamp() WHERE used_at IS NULL AND revoked_at IS NULL AND(created_by IN(SELECT id FROM users WHERE tenant_id=$1) OR lower(email) IN(SELECT lower(email) FROM users WHERE tenant_id=$1))`,
    [tenantId],
  );
}

export class WorkspaceOffboarding {
  /** @param {import('pg').Pool} pool @param {object} hub @param {{guardFile?:string|null,requireRoot?:boolean}} [options] */
  constructor(pool, hub, options = {}) {
    this.pool = pool;
    this.hub = hub;
    this.guardFile = options.guardFile ?? null;
    this.requireRoot = options.requireRoot ?? true;
    this.security = new AccountSecurity(pool);
    this.pending = null;
    this.timer = null;
    this.started = false;
    this.stopping = false;
    this.replayed = new Set();
  }

  /** @returns {Promise<Awaited<ReturnType<typeof readErasureGuard>>|null>} */
  async guard() {
    return this.guardFile
      ? readErasureGuard(this.guardFile, { requireRoot: this.requireRoot })
      : null;
  }

  /** @returns {Promise<void>} */
  async initialize() {
    if (this.guardFile) await this.replay((await this.guard()).records);
  }

  /** @returns {Promise<{state:'verified'|'stale'|'unavailable'|'not-configured',checkedAt:string|null,receipts:number|null}>} */
  async serviceStatus() {
    if (!this.guardFile)
      return { state: "not-configured", checkedAt: null, receipts: null };
    try {
      const guard = await readErasureGuard(this.guardFile, {
        requireRoot: this.requireRoot,
        fresh: false,
      });
      return {
        state:
          Date.now() - Date.parse(guard.checkedAt) <= ERASURE_MAX_AGE_MS
            ? "verified"
            : "stale",
        checkedAt: guard.checkedAt,
        receipts: guard.records.length,
      };
    } catch {
      return { state: "unavailable", checkedAt: null, receipts: null };
    }
  }

  /** @param {string} tenantId @returns {Promise<object>} */
  async status(tenantId) {
    const row = (
      await this.pool.query(
        `SELECT o.id,o.requested_at AS "requestedAt",o.erasure_authorized_at AS "authorizedAt",o.offsite_acknowledged_at AS "acknowledgedAt",o.erasure_started_at AS "startedAt",o.completed_at AS "completedAt",o.removed_rows AS "processedRows",o.last_failed_at AS "lastFailedAt",t.lifecycle AS state FROM tenants t LEFT JOIN workspace_offboarding o ON o.tenant_id=t.id WHERE t.id=$1`,
        [tenantId],
      )
    ).rows[0];
    if (!row) throw new SecurityError(404, "Workspace not found");
    let guard = null;
    try {
      guard = await this.guard();
    } catch {
      guard = null;
    }
    const receipt = guard?.records.find(
      (record) =>
        record.tenantId === tenantId &&
        record.id === row.id &&
        record.authorizedAt === row.authorizedAt?.toISOString(),
    );
    const pending = await unresolvedCleanup(this.pool, tenantId);
    return {
      ...row,
      processedRows: Number(row.processedRows ?? 0),
      cleanupPending: pending,
      receiptService: guard !== null,
      receiptReady: Boolean(receipt && row.acknowledgedAt),
      phase: row.completedAt
        ? "removed"
        : row.startedAt
          ? "erasing"
          : row.authorizedAt
            ? pending
              ? "cleanup"
              : receipt && row.acknowledgedAt
                ? "queued"
                : "awaiting-receipt"
            : row.id
              ? pending
                ? "cleanup"
                : "ready"
              : "none",
    };
  }

  /** @param {{id:string,token_hash:string}} actor @param {string} tenantId @param {{action:unknown,currentPassword:unknown,email?:unknown,password?:unknown,appId?:unknown,appSecret?:unknown,usePlatform?:unknown}} body @returns {Promise<void>} */
  async recover(actor, tenantId, body) {
    if (!["inspect", "stop", "repair"].includes(body.action))
      throw new SecurityError(400, "Choose a valid closure recovery action");
    const hash = await this.security.confirmedPassword(
      actor.id,
      body.currentPassword,
    );
    await this.security.withUser(actor.id, async (client, user) => {
      await this.security.activeSession(client, actor);
      if (!user.platform_admin)
        throw new SecurityError(403, "Administrator access is required");
      if (user.password_hash !== hash)
        throw new SecurityError(
          409,
          "Your account changed. Refresh this page and try again.",
        );
      await requireActiveTenant(client, user.tenant_id);
    });
    await this.hub.updateAccount(tenantId, async () => {
      const intent = (
        await this.pool.query(
          "SELECT 1 FROM workspace_offboarding o JOIN tenants t ON t.id=o.tenant_id WHERE o.tenant_id=$1 AND t.lifecycle='offboarding' AND o.erasure_started_at IS NULL",
          [tenantId],
        )
      ).rows[0];
      if (!intent)
        throw new SecurityError(
          409,
          "Closure recovery is unavailable for this workspace",
        );
      if (body.action === "repair") {
        await this.hub.connect(tenantId, {
          email: body.email,
          password: body.password,
          appId: body.appId,
          appSecret: body.appSecret,
          usePlatform: body.usePlatform,
        });
        await this.hub.discover(tenantId);
        return;
      }
      const runtime = await this.hub.forTenant(tenantId);
      if (
        !runtime.client ||
        !runtime.ready ||
        runtime.account?.profile !== "bluesun-bse20kh3"
      )
        throw new SecurityError(
          409,
          "Repair provider access to the original supported inverter before recovery",
        );
      const id = randomUUID();
      await this.pool.query(
        "INSERT INTO command_executions(id,tenant_id,account_id,device,actor,action,status) VALUES($1,$2,$3,$4,'Closure recovery',$5,'queued')",
        [
          id,
          tenantId,
          runtime.account.id,
          runtime.device,
          body.action === "stop" ? "stop" : "refresh",
        ],
      );
      await runtime.queue(async () => {
        runtime.executionId = id;
        try {
          await this.pool.query(
            "UPDATE command_executions SET status='running' WHERE id=$1",
            [id],
          );
          const clear =
            body.action === "stop"
              ? await runtime.clearScheduledPermission()
              : await runtime.journal.confirmOff(
                  unsigned32(
                    await runtime.inspector.read(3, 206, 2, "recovery"),
                  ),
                );
          await this.pool.query(
            "UPDATE command_executions SET status='succeeded',message=$2,completed_at=clock_timestamp() WHERE id=$1",
            [
              id,
              clear
                ? "Scheduled charging permission confirmed off"
                : "Scheduled charging permission is not confirmed off",
            ],
          );
        } catch (error) {
          await this.pool.query(
            "UPDATE command_executions SET status='failed',message='Closure recovery remains unconfirmed',completed_at=clock_timestamp() WHERE id=$1",
            [id],
          );
          throw error;
        } finally {
          runtime.executionId = null;
        }
      }, 10);
    });
  }

  /** @param {{id:string,token_hash:string}} actor @param {string} tenantId @param {{action:unknown,currentPassword:unknown,revision:unknown,confirmation:unknown,eraseConfirmed:unknown}} body @returns {Promise<{appKey:string|null}>} */
  async request(actor, tenantId, body) {
    if (
      !["close", "cancel", "erase"].includes(body.action) ||
      typeof body.revision !== "string" ||
      !/^\d{1,18}$/.test(body.revision) ||
      typeof body.confirmation !== "string"
    )
      throw new SecurityError(
        400,
        "Choose a valid closure action and current workspace revision",
      );
    if (body.action === "erase") {
      let guard = null;
      try {
        guard = await this.guard();
      } catch {
        guard = null;
      }
      if (body.eraseConfirmed !== true || !guard)
        throw new SecurityError(
          409,
          "A verified erasure receipt service and explicit confirmation are required",
        );
    }
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
      const members = (
        await client.query(
          "SELECT id,platform_admin FROM users WHERE tenant_id=$1 ORDER BY id FOR UPDATE",
          [tenantId],
        )
      ).rows;
      if (members.some((member) => member.platform_admin))
        throw new SecurityError(
          409,
          "Administrator workspace availability is managed by the server operator",
        );
      const appKey =
        (
          await client.query(
            "SELECT api_app_key FROM solarman_accounts WHERE tenant_id=$1",
            [tenantId],
          )
        ).rows[0]?.api_app_key ?? null;
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
          "SELECT name,lifecycle,lifecycle_revision::text AS revision FROM tenants WHERE id=$1 FOR UPDATE",
          [tenantId],
        )
      ).rows[0];
      const intent = (
        await client.query(
          "SELECT * FROM workspace_offboarding WHERE tenant_id=$1 FOR UPDATE",
          [tenantId],
        )
      ).rows[0];
      if (!tenant || !control || tenant.lifecycle === "removed")
        throw new SecurityError(404, "Workspace not found");
      if (tenant.revision !== body.revision)
        throw new SecurityError(
          409,
          "Workspace state changed. Refresh before making another change.",
        );
      if (tenant.name !== body.confirmation)
        throw new SecurityError(
          400,
          "Enter the workspace name exactly to confirm",
        );
      let state = "offboarding";
      if (body.action === "close") {
        if (!["active", "suspended"].includes(tenant.lifecycle))
          throw new SecurityError(
            409,
            "This workspace already has a closure request",
          );
        await quarantineWorkspace(client, tenantId, control.control_enabled);
        await revokeAccess(client, tenantId);
        await client.query(
          "INSERT INTO workspace_offboarding(tenant_id,requested_by) VALUES($1,$2)",
          [tenantId, user.id],
        );
      } else if (body.action === "cancel") {
        if (
          !intent ||
          intent.erasure_authorized_at ||
          intent.erasure_started_at
        )
          throw new SecurityError(
            409,
            "An authorized erasure cannot be cancelled",
          );
        state = "suspended";
        await client.query(
          "DELETE FROM workspace_offboarding WHERE tenant_id=$1",
          [tenantId],
        );
        await quarantineWorkspace(client, tenantId, control.control_enabled);
      } else {
        if (
          !intent ||
          tenant.lifecycle !== "offboarding" ||
          intent.erasure_authorized_at
        )
          throw new SecurityError(
            409,
            "The workspace is not ready for erasure authorization",
          );
        if (await unresolvedCleanup(client, tenantId))
          throw new SecurityError(
            409,
            "Resolve pending inverter cleanup and commands before authorizing erasure",
          );
        await client.query(
          "UPDATE workspace_offboarding SET erasure_authorized_at=date_trunc('milliseconds',clock_timestamp()) WHERE tenant_id=$1",
          [tenantId],
        );
        await revokeAccess(client, tenantId);
      }
      const revision = (
        await client.query(
          "UPDATE tenants SET lifecycle=$2,lifecycle_revision=lifecycle_revision+1,lifecycle_changed_at=clock_timestamp(),lifecycle_message='' WHERE id=$1 RETURNING lifecycle_revision",
          [tenantId, state],
        )
      ).rows[0].lifecycle_revision;
      await client.query(
        "INSERT INTO tenant_lifecycle_events(tenant_id,revision,state,message,actor_id) VALUES($1,$2,$3,'',$4)",
        [tenantId, revision, state, user.id],
      );
      return { appKey };
    });
  }

  /** @param {import('./erasure-guard.mjs').ErasureReceipt[]} records @returns {Promise<void>} */
  async replay(records) {
    for (const record of records) {
      const fingerprint = JSON.stringify(record);
      if (this.replayed.has(fingerprint)) continue;
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        const members = (
          await client.query(
            "SELECT id,platform_admin FROM users WHERE tenant_id=$1 ORDER BY id FOR UPDATE",
            [record.tenantId],
          )
        ).rows;
        if (members.some((member) => member.platform_admin))
          throw new ErasureGuardError("erasure_receipt_conflict");
        const account = (
          await client.query(
            "SELECT api_app_key FROM solarman_accounts WHERE tenant_id=$1",
            [record.tenantId],
          )
        ).rows[0];
        if (account?.api_app_key)
          await client.query(
            "SELECT app_key FROM api_app_budgets WHERE app_key=$1 FOR UPDATE",
            [account.api_app_key],
          );
        const control = (
          await client.query(
            "SELECT control_enabled FROM controller_state WHERE tenant_id=$1 FOR UPDATE",
            [record.tenantId],
          )
        ).rows[0];
        const tenant = (
          await client.query(
            "SELECT lifecycle FROM tenants WHERE id=$1 FOR UPDATE",
            [record.tenantId],
          )
        ).rows[0];
        const old = (
          await client.query(
            "SELECT id,erasure_authorized_at FROM workspace_offboarding WHERE tenant_id=$1 FOR UPDATE",
            [record.tenantId],
          )
        ).rows[0];
        if (!tenant || tenant.lifecycle === "removed") {
          await client.query("COMMIT");
          this.replayed.add(fingerprint);
          continue;
        }
        const matching =
          old?.id === record.id &&
          old.erasure_authorized_at?.toISOString() === record.authorizedAt;
        if (old?.erasure_authorized_at && !matching)
          throw new ErasureGuardError("erasure_receipt_conflict");
        if (!control)
          throw new ErasureGuardError("erasure_restore_state_invalid");
        await quarantineWorkspace(
          client,
          record.tenantId,
          control.control_enabled,
        );
        await revokeAccess(client, record.tenantId);
        if (old && !matching)
          await client.query(
            "DELETE FROM workspace_offboarding WHERE tenant_id=$1",
            [record.tenantId],
          );
        if (!matching)
          await client.query(
            "INSERT INTO workspace_offboarding(tenant_id,id,erasure_authorized_at) VALUES($1,$2,$3)",
            [record.tenantId, record.id, record.authorizedAt],
          );
        if (tenant.lifecycle !== "offboarding") {
          const revision = (
            await client.query(
              "UPDATE tenants SET lifecycle='offboarding',lifecycle_revision=lifecycle_revision+1,lifecycle_changed_at=clock_timestamp(),lifecycle_message='' WHERE id=$1 RETURNING lifecycle_revision",
              [record.tenantId],
            )
          ).rows[0].lifecycle_revision;
          await client.query(
            "INSERT INTO tenant_lifecycle_events(tenant_id,revision,state,message) VALUES($1,$2,'offboarding','')",
            [record.tenantId, revision],
          );
        }
        await client.query("COMMIT");
        this.replayed.add(fingerprint);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }
  }

  /** @returns {void} */
  start() {
    if (this.started || this.stopping) return;
    this.started = true;
    const loop = async () => {
      if (this.stopping) return;
      let progress = false;
      try {
        progress = Boolean(await this.runOnce());
      } catch {
        console.error(JSON.stringify({ event: "workspace_erasure_pending" }));
      }
      if (!this.stopping)
        this.timer = setTimeout(
          () => {
            void loop();
          },
          progress ? 1000 : 10000,
        );
    };
    void loop();
  }
  /** @returns {Promise<void>} */
  async stop() {
    this.stopping = true;
    clearTimeout(this.timer);
    await this.pending?.catch(() => {});
  }
  /** @returns {Promise<boolean>} */
  runOnce() {
    if (this.pending) return this.pending;
    if (this.stopping) return Promise.resolve(false);
    this.pending = this.tick().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  /** @returns {Promise<boolean>} */
  async tick() {
    const guard = await this.guard();
    if (!guard) return false;
    await this.replay(guard.records);
    const row = (
      await this.pool.query(
        "SELECT * FROM workspace_offboarding WHERE erasure_authorized_at IS NOT NULL AND offsite_acknowledged_at IS NOT NULL AND completed_at IS NULL ORDER BY last_attempted_at NULLS FIRST,requested_at LIMIT 1",
      )
    ).rows[0];
    if (!row) return false;
    await this.pool.query(
      "UPDATE workspace_offboarding SET last_attempted_at=clock_timestamp() WHERE tenant_id=$1",
      [row.tenant_id],
    );
    if (
      !guard.records.some(
        (record) =>
          record.id === row.id &&
          record.tenantId === row.tenant_id &&
          record.authorizedAt === row.erasure_authorized_at.toISOString(),
      )
    )
      return false;
    if (await unresolvedCleanup(this.pool, row.tenant_id)) return false;
    if (this.hub.accountUpdates?.has(row.tenant_id)) return false;
    this.hub.erasingTenants.add(row.tenant_id);
    this.hub.accountUpdates.add(row.tenant_id);
    let needsRecovery = false;
    try {
      const appKey = (
        await this.pool.query(
          "SELECT api_app_key FROM solarman_accounts WHERE tenant_id=$1",
          [row.tenant_id],
        )
      ).rows[0]?.api_app_key;
      const loading = this.hub.reloads?.get(row.tenant_id);
      if (loading) {
        // An erasure claim prevents a concurrent loader from publishing its runtime.
        await loading.catch(() => undefined);
      }
      const runtime = this.hub.runtimes.get(row.tenant_id);
      if (runtime) {
        await runtime.close();
        this.hub.runtimes.delete(row.tenant_id);
        runtime.client = null;
        runtime.controller = null;
        runtime.inspector = null;
        runtime.account = null;
        runtime.ready = false;
      }
      if (await unresolvedCleanup(this.pool, row.tenant_id)) {
        needsRecovery = true;
        return false;
      }
      const progress = await this.purge(row.tenant_id);
      if (appKey) await this.hub.budget.refreshCapacity(appKey);
      return progress;
    } catch (error) {
      await this.pool.query(
        "UPDATE workspace_offboarding SET last_failed_at=clock_timestamp() WHERE tenant_id=$1",
        [row.tenant_id],
      );
      throw error;
    } finally {
      this.hub.accountUpdates.delete(row.tenant_id);
      this.hub.erasingTenants.delete(row.tenant_id);
      if (needsRecovery && !this.hub.stopping) {
        try {
          await this.hub.forTenant(row.tenant_id);
        } catch {
          console.error(JSON.stringify({ event: "workspace_cleanup_pending" }));
        }
      }
    }
  }

  /** @param {string} tenantId @returns {Promise<boolean>} */
  async purge(tenantId) {
    const guard = await this.guard();
    const receipt = guard?.records.find(
      (record) => record.tenantId === tenantId,
    );
    if (!receipt) return false;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL statement_timeout='1s'");
      await client.query("SET LOCAL lock_timeout='200ms'");
      await client.query(
        "SELECT id FROM users WHERE tenant_id=$1 ORDER BY id FOR UPDATE",
        [tenantId],
      );
      await client.query(
        "SELECT tenant_id FROM controller_state WHERE tenant_id=$1 FOR UPDATE",
        [tenantId],
      );
      const tenant = (
        await client.query(
          "SELECT lifecycle FROM tenants WHERE id=$1 FOR UPDATE",
          [tenantId],
        )
      ).rows[0];
      const intent = (
        await client.query(
          "SELECT * FROM workspace_offboarding WHERE tenant_id=$1 FOR UPDATE",
          [tenantId],
        )
      ).rows[0];
      if (
        tenant?.lifecycle !== "offboarding" ||
        !intent?.offsite_acknowledged_at ||
        intent.id !== receipt.id ||
        intent.erasure_authorized_at?.toISOString() !== receipt.authorizedAt ||
        intent.completed_at ||
        (await unresolvedCleanup(client, tenantId))
      ) {
        await client.query("ROLLBACK");
        return false;
      }
      await revokeAccess(client, tenantId);
      await client.query(
        "UPDATE command_executions SET status='interrupted',completed_at=clock_timestamp() WHERE tenant_id=$1 AND status IN('queued','running')",
        [tenantId],
      );
      await client.query(
        "UPDATE solarman_accounts SET credentials=null,email='',validated_at=null,monitoring_admitted=false,connection_status='removed',connection_message=null,discovered_devices='[]',station_id=null WHERE tenant_id=$1",
        [tenantId],
      );
      await client.query(
        "UPDATE workspace_offboarding SET erasure_started_at=COALESCE(erasure_started_at,clock_timestamp()),last_failed_at=null WHERE tenant_id=$1",
        [tenantId],
      );
      let processed = 0;
      let more = false;
      let finalized = false;
      for (const sql of Object.values(ERASE)) {
        const n = (await client.query(sql, [tenantId])).rowCount;
        processed += n;
        more ||= n === LIMIT;
      }
      const invitations = (
        await client.query(
          `SELECT id FROM invitations WHERE created_by IN(SELECT id FROM users WHERE tenant_id=$1) OR lower(email) IN(SELECT lower(email) FROM users WHERE tenant_id=$1) ORDER BY id LIMIT ${LIMIT} FOR UPDATE`,
          [tenantId],
        )
      ).rows.map((row) => row.id);
      if (invitations.length) {
        await client.query(
          "UPDATE invitations SET replaced_by_id=null WHERE replaced_by_id=ANY($1::uuid[])",
          [invitations],
        );
        processed += (
          await client.query(
            "DELETE FROM invitations WHERE id=ANY($1::uuid[])",
            [invitations],
          )
        ).rowCount;
        more ||= invitations.length === LIMIT;
      }
      await client.query(
        "UPDATE workspace_offboarding SET removed_rows=removed_rows+$2 WHERE tenant_id=$1",
        [tenantId, processed],
      );
      if (!more) {
        const pending = (
          await client.query(
            `SELECT EXISTS(SELECT 1 FROM inverter_write_intents WHERE tenant_id=$1) OR EXISTS(SELECT 1 FROM command_executions WHERE tenant_id=$1) OR EXISTS(SELECT 1 FROM measurements WHERE tenant_id=$1) OR EXISTS(SELECT 1 FROM device_control_state WHERE tenant_id=$1) OR EXISTS(SELECT 1 FROM api_requests WHERE tenant_id=$1) AS remains`,
            [tenantId],
          )
        ).rows[0].remains;
        if (!pending) {
          await client.query(
            "DELETE FROM workspace_retention WHERE tenant_id=$1",
            [tenantId],
          );
          finalized = true;
          await client.query(
            "DELETE FROM solarman_accounts WHERE tenant_id=$1",
            [tenantId],
          );
          await client.query("DELETE FROM users WHERE tenant_id=$1", [
            tenantId,
          ]);
          await client.query(
            "DELETE FROM controller_state WHERE tenant_id=$1",
            [tenantId],
          );
          const revision = (
            await client.query(
              "UPDATE tenants SET name='Removed workspace',lifecycle='removed',lifecycle_revision=lifecycle_revision+1,lifecycle_changed_at=clock_timestamp(),lifecycle_message='' WHERE id=$1 RETURNING lifecycle_revision",
              [tenantId],
            )
          ).rows[0].lifecycle_revision;
          await client.query(
            "INSERT INTO tenant_lifecycle_events(tenant_id,revision,state,message) VALUES($1,$2,'removed','')",
            [tenantId, revision],
          );
          await client.query(
            "UPDATE workspace_offboarding SET completed_at=clock_timestamp(),requested_by=null WHERE tenant_id=$1",
            [tenantId],
          );
        }
      }
      await client.query("COMMIT");
      return processed > 0 || finalized;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
