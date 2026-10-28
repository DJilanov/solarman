/** @param {unknown} value @returns {Record<string, unknown>} */
function record(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

/** @param {unknown} value @returns {number | null} */
function number(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** @param {unknown} value @returns {string | null} */
function timestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString()
    : null;
}

/** @param {import('pg').Pool} pool @param {string} tenantId @param {{executionId?: string | null, offset: number}} options @returns {Promise<object>} */
export async function writeHistory(
  pool,
  tenantId,
  { executionId = null, offset },
) {
  const order = executionId ? "ASC" : "DESC";
  const result = await pool.query(
    `SELECT w.id,w.execution_id,w.device,w.operation,w.address,w.register_values,w.status,
    w.created_at,w.acknowledged_at,w.verified_at,w.reconciled_at,c.status AS job_status
    FROM inverter_write_intents w
    LEFT JOIN command_executions c ON c.tenant_id=w.tenant_id AND c.id=w.execution_id
    WHERE w.tenant_id=$1 ${executionId ? "AND w.execution_id=$3" : ""}
    ORDER BY w.created_at ${order},w.id ${order} LIMIT 26 OFFSET $2`,
    executionId ? [tenantId, offset, executionId] : [tenantId, offset],
  );
  return {
    writes: result.rows.slice(0, 25).map((write) => ({
      id: write.id,
      executionId: write.execution_id,
      device: write.device,
      operation: write.operation,
      address: write.address,
      registerValues: write.register_values,
      status: write.status,
      inFlight:
        ["queued", "running"].includes(write.job_status) &&
        ["prepared", "acknowledged"].includes(write.status),
      createdAt: write.created_at,
      acknowledgedAt: write.acknowledged_at,
      verifiedAt: write.verified_at,
      reconciledAt: write.reconciled_at,
    })),
    hasMoreWrites: result.rows.length > 25,
    offset,
  };
}

/** @param {unknown} value @returns {object} */
export function historyEvidence(value) {
  const detail = record(value);
  const events = Array.isArray(detail.events) ? detail.events.map(record) : [];
  const native = events.findLast((event) => event.event === "decision");
  const decision = { ...native, ...record(detail.decision) };
  const report = record(
    events.findLast((event) => event.event === "device_verification")?.report,
  );
  const checkedAt = timestamp(report.checkedAt);
  const checks = (Array.isArray(report.checks) ? report.checks : [])
    .map(record)
    .filter(
      (check) =>
        typeof check.label === "string" &&
        typeof check.passed === "boolean" &&
        number(check.expected) !== null &&
        ["", "W", "%", "s"].includes(check.unit),
    )
    .map((check) => ({
      label: check.label,
      passed: check.passed,
      actual: number(check.actual),
      expected: check.expected,
      unit: check.unit,
      ...(check.comparison === "at_most" ? { comparison: "at_most" } : {}),
    }));
  return {
    decision:
      typeof decision.charge === "boolean" &&
      typeof decision.reason === "string"
        ? {
            charge: decision.charge,
            reason: decision.reason,
            dryRun:
              typeof decision.dryRun === "boolean" ? decision.dryRun : null,
            acEnabled:
              typeof decision.acEnabled === "boolean"
                ? decision.acEnabled
                : null,
            soc: number(decision.soc),
            pvW: number(decision.pvW),
            loadW: number(decision.loadW),
            gridW: number(decision.gridW),
            batteryW: number(decision.batteryW),
          }
        : null,
    verification:
      checkedAt && typeof report.passed === "boolean" && checks.length
        ? { checkedAt, passed: report.passed, checks }
        : null,
    events: events
      .filter((event) =>
        [
          "native_policy_check",
          "manual_topup_expired",
          "ac_charge_changed",
          "write_acknowledgement_audit_recovered",
          "write_journal_unavailable",
        ].includes(event.event),
      )
      .map((event) => ({
        code: event.event,
        enabled: typeof event.enabled === "boolean" ? event.enabled : null,
        reason: [
          "native_audit",
          "observed_policy_deviation",
          "topup_assessment",
        ].includes(event.reason)
          ? event.reason
          : null,
      })),
  };
}
