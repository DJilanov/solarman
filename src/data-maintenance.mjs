const BATCH = 500;

const PRUNE = {
  measurements: `DELETE FROM measurements WHERE id IN (SELECT m.id FROM measurements m WHERE m.tenant_id=$1 AND m.observed_at<clock_timestamp()-$2*interval '1 day'
    AND m.id IS DISTINCT FROM (SELECT x.id FROM measurements x JOIN solarman_accounts a ON a.tenant_id=x.tenant_id AND a.id=x.account_id AND a.device_sn=x.device WHERE x.tenant_id=$1 ORDER BY x.observed_at DESC,x.id DESC LIMIT 1)
    ORDER BY m.observed_at,m.id LIMIT ${BATCH})`,
  writes: `DELETE FROM inverter_write_intents WHERE id IN (SELECT w.id FROM inverter_write_intents w JOIN device_control_state d USING(tenant_id,account_id,device)
    WHERE w.tenant_id=$1 AND d.state='clear' AND (w.status='verified' OR w.reconciled_at IS NOT NULL)
    AND COALESCE(w.reconciled_at,w.verified_at,w.created_at)<clock_timestamp()-$2*interval '1 day' ORDER BY w.created_at,w.id LIMIT ${BATCH})`,
  commands: `WITH candidates AS MATERIALIZED (SELECT c.id,c.tenant_id,c.user_id,c.idempotency_key,c.action,c.completed_at FROM command_executions c WHERE c.tenant_id=$1 AND c.status IN ('succeeded','failed','interrupted')
    AND c.completed_at<clock_timestamp()-$2*interval '1 day'
    AND NOT EXISTS (SELECT 1 FROM device_control_state d WHERE d.tenant_id=$1 AND d.state<>'clear')
    AND NOT EXISTS (SELECT 1 FROM inverter_write_intents w WHERE w.tenant_id=$1 AND w.execution_id=c.id)
    ORDER BY c.completed_at,c.id LIMIT ${BATCH} FOR UPDATE OF c SKIP LOCKED),
    receipts AS (INSERT INTO command_receipts(tenant_id,user_id,idempotency_key,action,completed_at)
      SELECT tenant_id,user_id,idempotency_key,action,completed_at FROM candidates WHERE user_id IS NOT NULL AND idempotency_key IS NOT NULL
      ON CONFLICT DO NOTHING RETURNING idempotency_key)
    DELETE FROM command_executions c USING candidates d WHERE c.id=d.id AND (SELECT count(*) FROM receipts)>=0`,
  incidents: `DELETE FROM operational_incidents WHERE id IN (SELECT id FROM operational_incidents WHERE tenant_id=$1 AND resolved_at<clock_timestamp()-$2*interval '1 day' ORDER BY resolved_at,id LIMIT ${BATCH})`,
  usage: `DELETE FROM api_requests WHERE id IN (SELECT id FROM api_requests WHERE tenant_id=$1 AND created_at<clock_timestamp()-GREATEST($2,366)*interval '1 day' ORDER BY created_at,id LIMIT ${BATCH})`,
  security: `DELETE FROM account_security_events WHERE id IN (SELECT id FROM account_security_events WHERE tenant_id=$1 AND occurred_at<clock_timestamp()-$2*interval '1 day' ORDER BY occurred_at,id LIMIT ${BATCH})`,
  recovery: `DELETE FROM account_recovery_tokens WHERE id IN (SELECT r.id FROM account_recovery_tokens r JOIN users u ON u.id=r.user_id WHERE u.tenant_id=$1
    AND COALESCE(r.used_at,r.revoked_at,r.expires_at)<clock_timestamp()-$2*interval '1 day'
    ORDER BY r.created_at,r.id LIMIT ${BATCH})`,
  providerReadings: `DELETE FROM provider_readings WHERE id IN (SELECT p.id FROM provider_readings p JOIN solarman_accounts a ON a.tenant_id=p.tenant_id AND a.id=p.account_id
    WHERE p.tenant_id=$1 AND p.device IS DISTINCT FROM a.device_sn AND p.collected_at<clock_timestamp()-$2*interval '1 day'
    AND NOT EXISTS (SELECT 1 FROM device_control_state d WHERE d.tenant_id=p.tenant_id AND d.account_id=p.account_id AND d.device=p.device AND d.state<>'clear')
    ORDER BY p.collected_at,p.id LIMIT ${BATCH})`,
};

export class DataMaintenance {
  /** @param {import('pg').Pool} pool */
  constructor(pool) {
    this.pool = pool;
    this.timer = null;
    this.pending = null;
    this.stopping = false;
    this.started = false;
  }

  /** @returns {void} */
  start() {
    if (this.started || this.stopping) return;
    this.started = true;
    const loop = async () => {
      this.timer = null;
      if (this.stopping) return;
      try {
        await this.runOnce();
      } catch {
        console.error(JSON.stringify({ event: "workspace_retention_failed" }));
      }
      if (!this.stopping)
        this.timer = setTimeout(() => {
          void loop();
        }, 60000);
    };
    void loop();
  }

  /** @returns {Promise<void>} */
  async stop() {
    this.stopping = true;
    clearTimeout(this.timer);
    await this.pending?.catch(() => {});
  }

  /** @param {string} [tenantId] @returns {Promise<object|null>} */
  runOnce(tenantId) {
    if (this.pending) return this.pending;
    if (this.stopping) return Promise.resolve(null);
    this.pending = this.prune(tenantId).finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  /** @param {string} [tenantId] @returns {Promise<object|null>} */
  async prune(tenantId) {
    const candidate = (
      await this.pool.query(
        `SELECT tenant_id FROM workspace_retention WHERE enabled AND next_run_at<=clock_timestamp() AND ($1::uuid IS NULL OR tenant_id=$1) ORDER BY next_run_at,tenant_id LIMIT 1`,
        [tenantId ?? null],
      )
    ).rows[0];
    if (!candidate) return null;
    let id = null;
    const client = await this.pool.connect();
    let revision = null;
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL statement_timeout='500ms'");
      await client.query("SET LOCAL lock_timeout='200ms'");
      // Receipt insertion references users. Acquire those keys before the policy lock, matching account updates.
      try {
        await client.query(
          "SELECT id FROM users WHERE tenant_id=$1 ORDER BY id FOR KEY SHARE NOWAIT",
          [candidate.tenant_id],
        );
      } catch (error) {
        if (error?.code !== "55P03") throw error;
        await client.query("ROLLBACK");
        return null;
      }
      const policy = (
        await client.query(
          `SELECT r.* FROM workspace_retention r JOIN tenants t ON t.id=r.tenant_id WHERE r.tenant_id=$1 AND r.enabled AND r.next_run_at<=clock_timestamp() AND t.lifecycle IN ('active','suspended') FOR UPDATE OF r SKIP LOCKED`,
          [candidate.tenant_id],
        )
      ).rows[0];
      if (!policy) {
        await client.query("ROLLBACK");
        return null;
      }
      revision = policy.revision;
      id = policy.tenant_id;
      const counts = {};
      for (const [section, sql] of Object.entries(PRUNE)) {
        const days = ["measurements", "providerReadings"].includes(section)
          ? policy.measurement_days
          : policy.activity_days;
        counts[section] = (await client.query(sql, [id, days])).rowCount;
      }
      const more = Object.values(counts).some((n) => n === BATCH);
      await client.query(
        `UPDATE workspace_retention SET last_run_at=clock_timestamp(),last_failed_at=null,last_counts=$2,next_run_at=clock_timestamp()+CASE WHEN $3 THEN interval '1 minute' ELSE interval '1 hour' END WHERE tenant_id=$1`,
        [id, JSON.stringify(counts), more],
      );
      await client.query("COMMIT");
      return counts;
    } catch (error) {
      await client.query("ROLLBACK");
      if (revision !== null)
        await this.pool.query(
          `UPDATE workspace_retention SET last_failed_at=clock_timestamp(),next_run_at=clock_timestamp()+interval '5 minutes' WHERE tenant_id=$1 AND revision=$2 AND enabled`,
          [id, revision],
        );
      throw error;
    } finally {
      client.release();
    }
  }
}
