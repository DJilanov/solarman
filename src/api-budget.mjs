import { createHash } from "node:crypto";
import { pollingConfig } from "./config.mjs";
import { allocateCapacity, ApiCapacityError } from "./api-capacity.mjs";

export const YEAR_MS = 365 * 86400_000;
const BALANCE_INTERVAL_MS = 86400_000;

/** @param {string} appId @returns {string} */
export function apiAppKey(appId) {
  return createHash("sha256")
    .update(`solarman:app-id:${appId.trim()}`)
    .digest("hex");
}

/** @param {Record<string, string | undefined>} env @returns {{limit: number, reserve: number}} */
export function budgetConfig(env) {
  /** @param {string} key @param {number} fallback @returns {number} */
  const integer = (key, fallback) => {
    const text = env[key] ?? String(fallback);
    const number = Number(text);
    if (!/^\d+$/.test(text) || !Number.isSafeInteger(number) || number < 1)
      throw new Error(`Invalid integer: ${key}`);
    return number;
  };
  const limit = integer("SOLARMAN_API_CALL_LIMIT", 200_000);
  const reserve = integer("SOLARMAN_API_RECOVERY_RESERVE", 2000);
  if (reserve >= limit)
    throw new Error(
      "The API recovery reserve must be smaller than the request limit",
    );
  return { limit, reserve };
}

/** @param {number} tracked @param {number | null} providerRemaining @param {{limit: number, reserve: number}} policy @returns {{remaining: number, routineRemaining: number, state: 'available' | 'recovery-only' | 'exhausted'}} */
export function availableBudget(tracked, providerRemaining, policy) {
  const remaining = Math.max(
    0,
    Math.min(policy.limit - tracked, providerRemaining ?? policy.limit),
  );
  const routineRemaining = Math.max(0, remaining - policy.reserve);
  return {
    remaining,
    routineRemaining,
    state:
      remaining === 0
        ? "exhausted"
        : routineRemaining === 0
          ? "recovery-only"
          : "available",
  };
}

/** @param {number} baseMs @param {number} consumers @param {number} activeCalls @param {{limit: number, reserve: number}} policy @returns {number} */
export function monitoringInterval(baseMs, consumers, activeCalls, policy) {
  const capacity =
    policy.limit -
    policy.reserve -
    Math.ceil(policy.limit * 0.05) -
    activeCalls;
  if (capacity <= 0) return 1800_000;
  const needed =
    Math.ceil((YEAR_MS * Math.max(1, consumers)) / capacity / 30_000) * 30_000;
  return Math.min(1800_000, Math.max(baseMs, needed));
}

export class ApiBudgetError extends Error {
  /** @param {'recovery-only' | 'exhausted'} state */
  constructor(state) {
    super(
      state === "exhausted"
        ? "The API request budget is exhausted"
        : "The remaining API budget is reserved for stopping and recovery",
    );
    this.name = "ApiBudgetError";
  }
}

export class ApiBudget {
  /** @param {import('pg').Pool} pool @param {Record<string, string | undefined>} env @param {(appKey:string)=>void} [capacityChanged] */
  constructor(pool, env, capacityChanged = () => {}) {
    this.pool = pool;
    this.policy = budgetConfig(env);
    this.syncs = new Map();
    this.cadence = pollingConfig(env);
    this.capacityPlans = new Map();
    this.capacityTasks = new Map();
    this.capacityChanged = capacityChanged;
  }

  /** @param {string} appKey @param {object} snapshot @returns {void} */
  publishCapacity(appKey, snapshot) {
    this.capacityPlans.set(appKey, snapshot);
    this.capacityChanged(appKey);
  }

  /** @template T @param {string} key @param {() => Promise<T>} operation @returns {Promise<T>} */
  async capacityTask(key, operation) {
    const previous = this.capacityTasks.get(key) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(operation);
    this.capacityTasks.set(key, task);
    try {
      return await task;
    } finally {
      if (this.capacityTasks.get(key) === task) this.capacityTasks.delete(key);
    }
  }

  /** @param {import('pg').PoolClient} client @param {string} appKey @returns {Promise<object>} */
  async readCapacity(client, appKey) {
    const members = (
      await client.query(
        `SELECT a.id,a.tenant_id,a.monitoring_admitted,c.control_enabled
      FROM solarman_accounts a JOIN controller_state c ON c.tenant_id=a.tenant_id
      WHERE a.api_app_key=$1 AND a.validated_at IS NOT NULL AND a.device_sn IS NOT NULL
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(a.discovered_devices) d WHERE d->>'deviceSn'=a.device_sn)`,
        [appKey],
      )
    ).rows;
    return {
      members,
      plan: this.planCapacity(members.filter((row) => row.monitoring_admitted)),
    };
  }

  /** @param {object[]} members @returns {ReturnType<typeof allocateCapacity>} */
  planCapacity(members) {
    const controls = members.filter((row) => row.control_enabled).length;
    return allocateCapacity(
      { controls, monitors: members.length - controls },
      this.policy,
      this.cadence,
    );
  }

  /** @param {string} appKey @param {string} tenantId @returns {object | null} */
  capacityFor(appKey, tenantId) {
    const snapshot = this.capacityPlans.get(appKey);
    if (!snapshot) return null;
    const admitted = snapshot.members.filter((row) => row.monitoring_admitted);
    const current = admitted.find((row) => row.tenant_id === tenantId);
    const activation = current
      ? this.planCapacity(
          admitted.map((row) =>
            row === current ? { ...row, control_enabled: true } : row,
          ),
        )
      : null;
    const controlAvailable = Boolean(activation?.fits);
    return {
      ...snapshot.plan,
      admitted: Boolean(current),
      controlAvailable,
      monitoringWorkspaces: admitted.length,
      controlWorkspaces: admitted.filter((row) => row.control_enabled).length,
      waitingWorkspaces: snapshot.members.length - admitted.length,
      activation,
    };
  }

  /** @param {string} appKey @returns {Promise<void>} */
  async refreshCapacity(appKey) {
    await this.capacityTask(appKey, async () => {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          "SELECT app_key FROM api_app_budgets WHERE app_key=$1 FOR UPDATE",
          [appKey],
        );
        const snapshot = await this.readCapacity(client, appKey);
        await client.query("COMMIT");
        this.publishCapacity(appKey, snapshot);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    });
  }

  /** @param {{appKey:string,tenantId:string,accountId:string,device:string,epoch:string,commissioningBinding?:string|null,commissioningMode?:'approved'|'attended'}} request @returns {Promise<boolean>} */
  async enableControl(request) {
    return this.capacityTask(request.appKey, async () => {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          "SELECT app_key FROM api_app_budgets WHERE app_key=$1 FOR UPDATE",
          [request.appKey],
        );
        const snapshot = await this.readCapacity(client, request.appKey);
        const current = snapshot.members.find(
          (row) =>
            row.id === request.accountId &&
            row.tenant_id === request.tenantId &&
            row.monitoring_admitted,
        );
        if (
          !current ||
          !this.planCapacity(
            snapshot.members
              .filter((row) => row.monitoring_admitted)
              .map((row) =>
                row === current ? { ...row, control_enabled: true } : row,
              ),
          ).fits
        )
          throw new ApiCapacityError();
        const updated = await client.query(
          `UPDATE controller_state SET control_enabled=true,paused=true,manual_topup=false,topup_expires_at=null,updated_at=now()
          WHERE tenant_id=$1 AND control_epoch=$2 AND EXISTS (SELECT 1 FROM tenants t WHERE t.id=$1 AND t.lifecycle='active') AND EXISTS (SELECT 1 FROM solarman_accounts a WHERE a.tenant_id=$1 AND a.id=$3 AND a.device_sn=$4 AND a.api_app_key=$5 AND a.monitoring_admitted)
          AND EXISTS(SELECT 1 FROM control_commissioning r WHERE r.tenant_id=$1 AND r.binding=$6 AND
            (($7='attended' AND r.state='attending' AND r.attended_until>clock_timestamp()) OR ($7='approved' AND r.state='approved')))
          RETURNING tenant_id`,
          [
            request.tenantId,
            request.epoch,
            request.accountId,
            request.device,
            request.appKey,
            request.commissioningBinding ?? null,
            request.commissioningMode ?? "approved",
          ],
        );
        const result = await this.readCapacity(client, request.appKey);
        await client.query("COMMIT");
        this.publishCapacity(request.appKey, result);
        return Boolean(updated.rowCount);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    });
  }

  /** @param {string} appKey @param {string} tenantId @param {string} accountId @param {{ready?:boolean}} [options] @returns {Promise<{admitted:boolean,revokeControl:boolean}>} */
  async register(appKey, tenantId, accountId, { ready } = {}) {
    return this.capacityTask(appKey, async () => {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          "INSERT INTO api_app_budgets (app_key) VALUES ($1) ON CONFLICT DO NOTHING",
          [appKey],
        );
        await client.query(
          "SELECT app_key FROM api_app_budgets WHERE app_key=$1 FOR UPDATE",
          [appKey],
        );
        await client.query(
          "UPDATE solarman_accounts SET api_app_key=$3 WHERE tenant_id=$1 AND id=$2",
          [tenantId, accountId, appKey],
        );
        const snapshot = await this.readCapacity(client, appKey);
        const current = snapshot.members.find(
          (row) => row.id === accountId && row.tenant_id === tenantId,
        );
        const others = snapshot.members.filter(
          (row) => row.monitoring_admitted && row.id !== accountId,
        );
        let admitted = Boolean(current?.monitoring_admitted);
        let revokeControl = false;
        if (ready !== undefined) {
          admitted = Boolean(
            ready &&
              current &&
              this.planCapacity([
                ...others,
                { ...current, monitoring_admitted: true },
              ]).fits,
          );
          const control = (
            await client.query(
              "SELECT control_enabled FROM controller_state WHERE tenant_id=$1",
              [tenantId],
            )
          ).rows[0];
          revokeControl = Boolean(control?.control_enabled && !admitted);
          if (revokeControl)
            admitted = Boolean(
              ready &&
                current &&
                this.planCapacity([
                  ...others,
                  {
                    ...current,
                    monitoring_admitted: true,
                    control_enabled: false,
                  },
                ]).fits,
            );
          await client.query(
            "UPDATE solarman_accounts SET monitoring_admitted=$3 WHERE tenant_id=$1 AND id=$2",
            [tenantId, accountId, admitted],
          );
          if (!admitted || revokeControl)
            await client.query(
              `UPDATE controller_state SET paused=true,manual_topup=false,topup_expires_at=null,
          control_epoch=control_epoch+CASE WHEN NOT paused OR manual_topup THEN 1 ELSE 0 END,updated_at=now() WHERE tenant_id=$1`,
              [tenantId],
            );
        }
        // Legacy requests have no App ID provenance; charge them conservatively to the current binding once.
        await client.query(
          "UPDATE api_requests SET app_key=$3 WHERE tenant_id=$1 AND account_id=$2 AND app_key IS NULL",
          [tenantId, accountId, appKey],
        );
        const result = await this.readCapacity(client, appKey);
        await client.query("COMMIT");
        this.publishCapacity(appKey, result);
        return { admitted, revokeControl };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    });
  }

  /** @param {{appKey: string, tenantId: string, accountId: string, kind: string, purpose: 'routine' | 'recovery' | 'balance'}} request @returns {Promise<void>} */
  async reserve(request) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "INSERT INTO api_app_budgets (app_key) VALUES ($1) ON CONFLICT DO NOTHING",
        [request.appKey],
      );
      const row = (
        await client.query(
          "SELECT provider_remaining,balance_attempted_at FROM api_app_budgets WHERE app_key=$1 FOR UPDATE",
          [request.appKey],
        )
      ).rows[0];
      const count = (
        await client.query(
          "SELECT count(*)::integer AS used FROM api_requests WHERE app_key=$1 AND created_at>=now()-interval '365 days'",
          [request.appKey],
        )
      ).rows[0].used;
      const budget = availableBudget(
        count,
        row.provider_remaining === null ? null : Number(row.provider_remaining),
        this.policy,
      );
      let balanceProbe = false;
      if (request.purpose === "balance" && row.balance_attempted_at) {
        const probes = (
          await client.query(
            "SELECT count(*)::integer AS used FROM api_requests WHERE app_key=$1 AND purpose='balance' AND created_at>=$2",
            [request.appKey, row.balance_attempted_at],
          )
        ).rows[0].used;
        balanceProbe =
          Date.now() - row.balance_attempted_at.getTime() <= 60_000 &&
          probes < 2 &&
          count < this.policy.limit &&
          ["token", "read"].includes(request.kind);
      }
      if (
        !balanceProbe &&
        (request.purpose === "balance" ||
          budget.remaining === 0 ||
          (request.purpose !== "recovery" && budget.routineRemaining === 0))
      )
        throw new ApiBudgetError(
          budget.state === "exhausted" ? "exhausted" : "recovery-only",
        );
      await client.query(
        "INSERT INTO api_requests (tenant_id,account_id,kind,app_key,purpose) VALUES ($1,$2,$3,$4,$5)",
        [
          request.tenantId,
          request.accountId,
          request.kind,
          request.appKey,
          request.purpose,
        ],
      );
      await client.query(
        "UPDATE api_app_budgets SET provider_remaining=CASE WHEN provider_remaining IS NULL THEN NULL ELSE GREATEST(0,provider_remaining-1) END WHERE app_key=$1",
        [request.appKey],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /** @param {string} appKey @returns {Promise<object | null>} */
  async status(appKey) {
    const result = await this.pool.query(
      `SELECT b.provider_remaining,b.provider_checked_at,b.balance_attempted_at,
      (SELECT count(*)::integer FROM api_requests r WHERE r.app_key=b.app_key AND r.created_at>=now()-interval '365 days') AS tracked,
      (SELECT count(*)::integer FROM solarman_accounts a WHERE a.api_app_key=b.app_key AND a.validated_at IS NOT NULL AND a.device_sn IS NOT NULL) AS workspaces
      FROM api_app_budgets b WHERE b.app_key=$1`,
      [appKey],
    );
    const row = result.rows[0];
    if (!row) return null;
    const providerRemaining =
      row.provider_remaining === null ? null : Number(row.provider_remaining);
    return {
      ...this.policy,
      ...availableBudget(row.tracked, providerRemaining, this.policy),
      tracked: row.tracked,
      workspaces: row.workspaces,
      providerRemaining,
      providerCheckedAt: row.provider_checked_at,
      balanceAttemptedAt: row.balance_attempted_at,
    };
  }

  /** @param {string} appKey @param {import('./solarman.mjs').SolarmanClient} client @returns {Promise<void>} */
  async refreshBalance(appKey, client) {
    if (this.syncs.has(appKey)) return this.syncs.get(appKey);
    const operation = this.syncBalance(appKey, client);
    this.syncs.set(appKey, operation);
    try {
      await operation;
    } finally {
      this.syncs.delete(appKey);
    }
  }

  /** @param {string} appKey @param {import('./solarman.mjs').SolarmanClient} client @returns {Promise<void>} */
  async syncBalance(appKey, client) {
    const claim = await this.pool.query(
      `UPDATE api_app_budgets SET balance_attempted_at=now() WHERE app_key=$1
      AND (balance_attempted_at IS NULL OR balance_attempted_at<now()-($2::integer*interval '1 millisecond'))
      RETURNING balance_attempted_at`,
      [appKey, BALANCE_INTERVAL_MS],
    );
    if (!claim.rowCount) return;
    const marker = (
      await this.pool.query(
        "SELECT COALESCE(max(id),0)::text AS id FROM api_requests WHERE app_key=$1 AND created_at<now()-interval '2 minutes'",
        [appKey],
      )
    ).rows[0].id;
    let result;
    try {
      result = await client.api("/account/v1.0/balance", {
        appId: client.config.appId,
      });
      if (!Number.isSafeInteger(result.total) || Number(result.total) < 0)
        return;
    } catch {
      // A failed optional balance check leaves the previous estimate and attempt time visible.
      return;
    }
    // Include recent in-flight reservations, which the provider may not have deducted yet.
    // Subtract the balance request itself as well.
    // This intentionally underestimates capacity if the provider already deducted some of them.
    const connection = await this.pool.connect();
    try {
      await connection.query("BEGIN");
      await connection.query(
        "SELECT app_key FROM api_app_budgets WHERE app_key=$1 FOR UPDATE",
        [appKey],
      );
      await connection.query(
        `UPDATE api_app_budgets SET provider_remaining=GREATEST(0,$2::bigint-(
        SELECT count(*) FROM api_requests WHERE app_key=$1 AND id>$3::bigint)),provider_checked_at=now() WHERE app_key=$1`,
        [appKey, result.total, marker],
      );
      await connection.query("COMMIT");
    } catch (error) {
      await connection.query("ROLLBACK");
      throw error;
    } finally {
      connection.release();
    }
  }
}
