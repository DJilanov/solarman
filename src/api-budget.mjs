import { createHash } from "node:crypto";

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
  /** @param {import('pg').Pool} pool @param {Record<string, string | undefined>} env */
  constructor(pool, env) {
    this.pool = pool;
    this.policy = budgetConfig(env);
    this.syncs = new Map();
  }

  /** @param {string} appKey @param {string} tenantId @param {string} accountId @returns {Promise<void>} */
  async register(appKey, tenantId, accountId) {
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
      // Legacy requests have no App ID provenance; charge them conservatively to the current binding once.
      await client.query(
        "UPDATE api_requests SET app_key=$3 WHERE tenant_id=$1 AND account_id=$2 AND app_key IS NULL",
        [tenantId, accountId, appKey],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
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
