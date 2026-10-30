import { firmwareVersion } from "./telemetry.mjs";

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

/** @param {Record<string,unknown>} event @returns {object|null} */
function clockFailure(event) {
  const checkedAt = timestamp(event.checkedAt);
  if (!checkedAt) return null;
  let timezone = null;
  if (typeof event.timezone === "string" && event.timezone.length <= 100) {
    try {
      new Intl.DateTimeFormat("en", { timeZone: event.timezone }).format();
      timezone = event.timezone;
    } catch {
      /* An invalid saved zone stays unavailable. */
    }
  }
  const skew = number(event.skewSeconds),
    maximum = number(event.maximumSkewSeconds);
  return {
    checkedAt,
    collectedAt: timestamp(event.collectedAt),
    receivedAt: timestamp(event.receivedAt),
    timezone,
    reportedTime:
      typeof event.reportedTime === "string" &&
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(event.reportedTime)
        ? event.reportedTime
        : null,
    skewSeconds: skew !== null && skew >= 0 ? skew : null,
    maximumSkewSeconds: maximum !== null && maximum >= 0 ? maximum : null,
  };
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
    FROM (SELECT id,tenant_id,execution_id,device,operation,address,register_values,status,created_at,acknowledged_at,verified_at,reconciled_at FROM inverter_write_intents
      UNION ALL SELECT w.id,w.tenant_id,w.execution_id,p.device,CASE WHEN w.phase='apply' THEN 'outage_apply' ELSE 'outage_restore' END,w.address,w.register_values,w.status,w.created_at,w.acknowledged_at,w.verified_at,w.reconciled_at FROM outage_write_intents w JOIN outage_preparations p ON p.tenant_id=w.tenant_id AND p.id=w.preparation_id) w
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
  const firmware = record(report.firmware);
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
        ? {
            checkedAt,
            passed: report.passed,
            checks,
            firmware: report.firmware
              ? {
                  protocol: firmwareVersion(firmware.protocol),
                  dsp: firmwareVersion(firmware.dsp),
                  hmi: firmwareVersion(firmware.hmi),
                }
              : null,
          }
        : null,
    events: events
      .filter((event) =>
        [
          "native_policy_check",
          "manual_topup_expired",
          "ac_charge_changed",
          "write_acknowledgement_audit_recovered",
          "write_journal_unavailable",
          "firmware_verification_invalidated",
          "inverter_clock_check_failed",
          "inverter_clock_check_recovered",
        ].includes(event.event),
      )
      .map((event) => ({
        code: event.event,
        ...(event.event === "inverter_clock_check_failed"
          ? { clock: clockFailure(event) }
          : {}),
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
