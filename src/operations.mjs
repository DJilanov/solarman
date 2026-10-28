import { randomUUID } from "node:crypto";
import { ApiBudgetError } from "./api-budget.mjs";

// Allow one five-minute logger upload cycle and three minutes of delivery jitter.
const UPLOAD_GRACE_MS = 480000;

/** @param {string} accountId @param {string} device @returns {string} */
function binding(accountId, device) {
  return `${accountId}:${device}`;
}

export class DeviceHealth {
  /** @param {import('pg').Pool} pool @param {{tenantId: string, accountId: string | null, device: string | null}} context */
  constructor(pool, context) {
    this.pool = pool;
    this.context = context;
    this.values = [context.tenantId, context.accountId, context.device];
  }

  /** @returns {Promise<object | null>} */
  async initialize() {
    if (!this.context.accountId || !this.context.device) return null;
    await this.pool.query(
      "INSERT INTO device_health (tenant_id,account_id,device) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING",
      this.values,
    );
    return (
      await this.pool.query(
        "SELECT * FROM device_health WHERE tenant_id=$1 AND account_id=$2 AND device=$3",
        this.values,
      )
    ).rows[0];
  }

  /** @param {import('./telemetry.mjs').ProviderReading} reading @returns {Promise<void>} */
  async upload(reading) {
    await this.pool.query(
      `UPDATE device_health SET uploaded_at=GREATEST(uploaded_at,$4),device_state=$5,reported_at=now()
      WHERE tenant_id=$1 AND account_id=$2 AND device=$3`,
      [...this.values, reading.collectedAt, reading.deviceState],
    );
  }

  /** @param {boolean} fault @returns {Promise<void>} */
  async controlFault(fault) {
    if (!this.context.accountId || !this.context.device) return;
    await this.pool.query(
      "UPDATE device_health SET control_fault=$4,control_fault_at=CASE WHEN $4 THEN COALESCE(control_fault_at,now()) ELSE null END WHERE tenant_id=$1 AND account_id=$2 AND device=$3",
      [...this.values, fault],
    );
  }

  /** @template T @param {() => Promise<T>} operation @param {() => boolean} fault @returns {Promise<T>} */
  async run(operation, fault) {
    await this.pool.query(
      "UPDATE device_health SET attempted_at=now() WHERE tenant_id=$1 AND account_id=$2 AND device=$3",
      this.values,
    );
    try {
      const result = await operation();
      await this.pool.query(
        "UPDATE device_health SET succeeded_at=now(),failures=0,control_fault=$4,control_fault_at=CASE WHEN $4 THEN COALESCE(control_fault_at,now()) ELSE null END WHERE tenant_id=$1 AND account_id=$2 AND device=$3",
        [...this.values, fault()],
      );
      return result;
    } catch (error) {
      if (!(error instanceof ApiBudgetError)) {
        try {
          await this.pool.query(
            "UPDATE device_health SET failed_at=now(),failures=LEAST(failures::bigint+1,2147483647),control_fault=$4,control_fault_at=CASE WHEN $4 THEN COALESCE(control_fault_at,now()) ELSE null END WHERE tenant_id=$1 AND account_id=$2 AND device=$3",
            [...this.values, fault()],
          );
        } catch {
          console.error(
            JSON.stringify({ event: "device_health_update_failed" }),
          );
        }
      }
      throw error;
    }
  }
}

/** @param {object} row @param {number} now @param {number} pollMs @returns {object[]} */
export function deviceIssues(row, now, pollMs) {
  const issues = [];
  const capacityWaiting =
    row.monitoring_eligible === true && row.monitoring_admitted === false;
  if (capacityWaiting)
    issues.push({
      kind: "api_capacity",
      severity: "warning",
      at: new Date(now),
    });
  const source = row.uploaded_at ?? row.created_at;
  const upload = new Date(source).getTime();
  if (
    !capacityWaiting &&
    source &&
    Number.isFinite(upload) &&
    now - upload > pollMs + UPLOAD_GRACE_MS
  )
    issues.push({
      kind: "telemetry_stale",
      severity: "warning",
      at: new Date(now),
    });
  if (
    row.device_state !== null &&
    row.device_state !== undefined &&
    row.device_state !== 1
  )
    issues.push({
      kind: "device_offline",
      severity: "critical",
      at: row.reported_at ?? row.created_at,
    });
  if (!capacityWaiting && row.failures >= 3)
    issues.push({
      kind: "request_failures",
      severity: "warning",
      at: row.failed_at ?? row.created_at,
    });
  if (row.control_fault)
    issues.push({
      kind: "control_fault",
      severity: "critical",
      at:
        row.control_fault_at ??
        row.succeeded_at ??
        row.failed_at ??
        row.created_at,
    });
  return issues;
}

/** @param {object} row @returns {object} */
function incident(row) {
  return {
    id: row.id,
    kind: row.kind,
    severity: row.severity,
    device: row.device,
    detailCode: row.detail_code,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    resolvedAt: row.resolved_at,
    resolutionReason: row.resolution_reason,
    acknowledgedAt: row.acknowledged_at,
    revision: row.revision,
  };
}

export class Operations {
  /** @param {import('pg').Pool} pool @param {object} hub */
  constructor(pool, hub) {
    this.pool = pool;
    this.hub = hub;
    this.timer = null;
    this.pending = null;
    this.startedAt = null;
    this.checkedAt = null;
    this.stopping = false;
  }

  /** @returns {{checkedAt: string | null, state: 'current' | 'starting' | 'delayed'}} */
  status() {
    const age = Date.now() - (this.checkedAt ?? this.startedAt ?? Date.now());
    return {
      checkedAt:
        this.checkedAt === null ? null : new Date(this.checkedAt).toISOString(),
      state:
        age > 180000
          ? "delayed"
          : this.checkedAt === null
            ? "starting"
            : "current",
    };
  }

  start() {
    if (this.startedAt !== null) return;
    this.startedAt = Date.now();
    const loop = async () => {
      if (this.stopping || this.hub.stopping) return;
      try {
        await this.refresh();
      } catch {
        console.error(JSON.stringify({ event: "operational_monitor_failed" }));
      }
      if (!this.stopping && !this.hub.stopping)
        this.timer = setTimeout(() => {
          void loop();
        }, 60000);
    };
    void loop();
  }

  async stop() {
    this.stopping = true;
    clearTimeout(this.timer);
    await this.pending?.catch(() => {});
  }

  /** @returns {Promise<void>} */
  refresh() {
    if (this.pending) return this.pending;
    this.pending = this.inspect().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  async inspect() {
    const now = Date.now();
    const [accounts, debts, tenants] = await Promise.all([
      this.pool
        .query(`SELECT a.tenant_id,a.id AS account_id,a.device_sn AS device,a.monitoring_admitted,h.created_at,h.attempted_at,h.succeeded_at,h.failed_at,h.uploaded_at,h.reported_at,h.device_state,h.failures,h.control_fault,h.control_fault_at
        FROM solarman_accounts a LEFT JOIN device_health h ON h.tenant_id=a.tenant_id AND h.account_id=a.id AND h.device=a.device_sn WHERE a.device_sn IS NOT NULL`),
      this.pool.query(
        "SELECT tenant_id,account_id,device,updated_at FROM device_control_state WHERE state IN ('uncertain','cleanup-required') AND updated_at<now()-interval '2 minutes'",
      ),
      this.pool.query("SELECT id FROM tenants"),
    ]);
    const groups = new Map(
      tenants.rows.map((row) => [row.id, { desired: [], scopes: new Set() }]),
    );
    const quotas = new Map();
    for (const row of accounts.rows) {
      const group = groups.get(row.tenant_id);
      if (!group) continue;
      const scope = binding(row.account_id, row.device);
      group.scopes.add(scope);
      const runtime = this.hub.runtimes.get(row.tenant_id);
      const pollMs = runtime?.pollMs ?? 300000;
      for (const issue of deviceIssues(
        {
          ...row,
          monitoring_eligible: Boolean(runtime?.ready && runtime.client),
        },
        now,
        pollMs,
      ))
        group.desired.push({ ...row, ...issue, binding: scope });
      if (runtime?.appKey) {
        const quotaScope = `api:${runtime.appKey}:${row.account_id}`;
        group.scopes.add(quotaScope);
        if (!quotas.has(runtime.appKey))
          quotas.set(
            runtime.appKey,
            await this.hub.budget.status(runtime.appKey),
          );
        const budget = quotas.get(runtime.appKey);
        if (
          budget &&
          budget.routineRemaining <= Math.max(100, budget.limit * 0.1)
        )
          group.desired.push({
            ...row,
            binding: quotaScope,
            kind: "api_quota",
            severity: budget.state === "available" ? "warning" : "critical",
            detailCode: budget.state === "available" ? "low" : budget.state,
            at: new Date(now),
          });
      }
    }
    for (const row of debts.rows)
      groups.get(row.tenant_id)?.desired.push({
        ...row,
        binding: binding(row.account_id, row.device),
        kind: "cleanup_pending",
        severity: "critical",
        at: row.updated_at,
      });
    for (const [tenantId, group] of groups)
      await this.reconcile(tenantId, group.desired, group.scopes, now);
    this.checkedAt = Date.now();
  }

  /** @param {string} tenantId @param {object[]} desired @param {Set<string>} scopes @param {number} now @returns {Promise<void>} */
  async reconcile(tenantId, desired, scopes, now = Date.now()) {
    const connection = await this.pool.connect();
    try {
      await connection.query("BEGIN");
      await connection.query("SET LOCAL lock_timeout='5s'");
      await connection.query("SET LOCAL statement_timeout='10s'");
      await connection.query("SELECT id FROM tenants WHERE id=$1 FOR UPDATE", [
        tenantId,
      ]);
      const active = await connection.query(
        "SELECT id,binding,kind FROM operational_incidents WHERE tenant_id=$1 AND resolved_at IS NULL",
        [tenantId],
      );
      for (const row of desired) {
        await connection.query(
          `INSERT INTO operational_incidents (id,tenant_id,account_id,device,binding,kind,severity,detail_code,first_seen_at,last_seen_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)
          ON CONFLICT (tenant_id,binding,kind) WHERE resolved_at IS NULL DO UPDATE SET
          severity=EXCLUDED.severity,detail_code=EXCLUDED.detail_code,last_seen_at=GREATEST(operational_incidents.last_seen_at,EXCLUDED.last_seen_at),
          acknowledged_at=CASE WHEN (operational_incidents.severity='warning' AND EXCLUDED.severity='critical') OR (EXCLUDED.detail_code='exhausted' AND operational_incidents.detail_code IS DISTINCT FROM 'exhausted') THEN null ELSE operational_incidents.acknowledged_at END,
          acknowledged_by=CASE WHEN (operational_incidents.severity='warning' AND EXCLUDED.severity='critical') OR (EXCLUDED.detail_code='exhausted' AND operational_incidents.detail_code IS DISTINCT FROM 'exhausted') THEN null ELSE operational_incidents.acknowledged_by END,
          revision=operational_incidents.revision+CASE WHEN (operational_incidents.severity='warning' AND EXCLUDED.severity='critical') OR (EXCLUDED.detail_code='exhausted' AND operational_incidents.detail_code IS DISTINCT FROM 'exhausted') THEN 1 ELSE 0 END`,
          [
            randomUUID(),
            tenantId,
            row.account_id,
            row.device,
            row.binding,
            row.kind,
            row.severity,
            row.detailCode ?? null,
            row.at,
          ],
        );
      }
      for (const row of active.rows)
        if (
          !desired.some(
            (entry) => entry.binding === row.binding && entry.kind === row.kind,
          )
        )
          await connection.query(
            "UPDATE operational_incidents SET resolved_at=$3,resolution_reason=$4 WHERE tenant_id=$1 AND id=$2",
            [
              tenantId,
              row.id,
              new Date(now),
              row.kind === "cleanup_pending" || scopes.has(row.binding)
                ? "cleared"
                : "binding_changed",
            ],
          );
      await connection.query("COMMIT");
    } catch (error) {
      await connection.query("ROLLBACK");
      throw error;
    } finally {
      connection.release();
    }
  }

  /** @param {string} tenantId @param {'active' | 'resolved' | 'all'} filter @param {number} offset @returns {Promise<object>} */
  async list(tenantId, filter = "active", offset = 0) {
    const result = await this.pool.query(
      `SELECT *,count(*) OVER()::int AS total,count(*) FILTER (WHERE resolved_at IS NULL AND acknowledged_at IS NULL) OVER()::int AS unseen
      FROM operational_incidents WHERE tenant_id=$1 AND ($2='all' OR ($2='active' AND resolved_at IS NULL) OR ($2='resolved' AND resolved_at IS NOT NULL))
      ORDER BY (resolved_at IS NULL) DESC,(severity='critical') DESC,last_seen_at DESC,id DESC LIMIT 26 OFFSET $3`,
      [tenantId, filter, offset],
    );
    let total = result.rows[0]?.total ?? 0;
    let unseen = result.rows[0]?.unseen ?? 0;
    if (!result.rowCount && offset > 0) {
      const counts = await this.pool.query(
        "SELECT count(*)::int AS total,count(*) FILTER (WHERE resolved_at IS NULL AND acknowledged_at IS NULL)::int AS unseen FROM operational_incidents WHERE tenant_id=$1 AND ($2='all' OR ($2='active' AND resolved_at IS NULL) OR ($2='resolved' AND resolved_at IS NOT NULL))",
        [tenantId, filter],
      );
      total = counts.rows[0].total;
      unseen = counts.rows[0].unseen;
    }
    return {
      items: result.rows.slice(0, 25).map(incident),
      hasMore: result.rows.length > 25,
      offset,
      total,
      unseen,
      monitor: this.status(),
    };
  }

  /** @param {string} tenantId @returns {Promise<object>} */
  async summary(tenantId) {
    const list = await this.list(tenantId);
    return {
      items: list.items.slice(0, 3),
      active: list.total,
      unseen: list.unseen,
      monitor: list.monitor,
    };
  }

  /** @param {string} tenantId @returns {Promise<object | null>} */
  async deviceStatus(tenantId) {
    const result = await this.pool.query(
      `SELECT h.*,a.monitoring_admitted FROM device_health h JOIN solarman_accounts a ON a.tenant_id=h.tenant_id AND a.id=h.account_id AND a.device_sn=h.device WHERE h.tenant_id=$1`,
      [tenantId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      device: row.device,
      monitoringAdmitted: row.monitoring_admitted,
      capacityWaiting: Boolean(
        this.hub.runtimes.get(tenantId)?.ready &&
          this.hub.runtimes.get(tenantId)?.client &&
          row.monitoring_admitted === false,
      ),
      attemptedAt: row.attempted_at,
      succeededAt: row.succeeded_at,
      failedAt: row.failed_at,
      uploadedAt: row.uploaded_at,
      deviceState: row.device_state,
      failures: row.failures,
      controlFault: row.control_fault,
      staleAfterSeconds:
        ((this.hub.runtimes.get(tenantId)?.pollMs ?? 300000) +
          UPLOAD_GRACE_MS) /
        1000,
    };
  }

  /** @param {string} tenantId @param {string} id @param {string} userId @param {number} revision @returns {Promise<object | null>} */
  async acknowledge(tenantId, id, userId, revision) {
    const result = await this.pool.query(
      "UPDATE operational_incidents SET acknowledged_at=COALESCE(acknowledged_at,now()),acknowledged_by=COALESCE(acknowledged_by,$3) WHERE tenant_id=$1 AND id=$2 AND revision=$4 RETURNING *",
      [tenantId, id, userId, revision],
    );
    return result.rowCount ? incident(result.rows[0]) : null;
  }
}
