const YEAR_MS = 365 * 86400_000;
const STEP_MS = 30_000;

/** @param {number} value @returns {number} */
function rounded(value) {
  return Math.ceil(value / STEP_MS) * STEP_MS;
}

/** @param {{monitors:number,controls:number}} consumers @param {{limit:number,reserve:number}} policy @param {{pollMs:number,telemetryPollMs:number,controlAuditMs:number,chargeWindowMinutes:number}} cadence @returns {{fits:boolean,planningLimit:number,reservedAnnual:number,monitorMs:number,scheduledMs:number,assessmentMs:number}} */
export function allocateCapacity({ monitors, controls }, policy, cadence) {
  if (
    ![monitors, controls].every(
      (value) => Number.isSafeInteger(value) && value >= 0,
    )
  )
    throw new Error("Invalid API capacity consumers");
  const planningLimit =
    policy.limit - policy.reserve - Math.ceil(policy.limit * 0.05);
  const maxScheduled = Math.min(
    1800_000,
    Math.floor((cadence.chargeWindowMinutes * 60_000 - 180_001) / STEP_MS) *
      STEP_MS,
  );
  // A configured minimum need not be a multiple of 30 seconds.
  const scheduledFloor = Math.max(cadence.pollMs, maxScheduled);
  const auditFloor = (5 * YEAR_MS) / cadence.controlAuditMs;
  const count = monitors + controls;
  if (count === 0)
    return {
      fits: true,
      planningLimit,
      reservedAnnual: 0,
      monitorMs: cadence.telemetryPollMs,
      scheduledMs: cadence.pollMs,
      assessmentMs: cadence.pollMs,
    };
  const candidates = [cadence.telemetryPollMs];
  for (
    let interval = rounded(cadence.telemetryPollMs + 1);
    interval <= 1800_000;
    interval += STEP_MS
  )
    candidates.push(interval);
  for (const monitorMs of candidates) {
    const telemetry = YEAR_MS / monitorMs;
    const minimumControl = Math.max(
      auditFloor + telemetry,
      (6 * YEAR_MS) / scheduledFloor,
    );
    if (monitors * telemetry + controls * minimumControl > planningLimit)
      continue;
    if (controls === 0)
      return {
        fits: true,
        planningLimit,
        reservedAnnual: Math.ceil(monitors * telemetry),
        monitorMs,
        scheduledMs: cadence.pollMs,
        assessmentMs: cadence.pollMs,
      };
    const controlBudget = (planningLimit - monitors * telemetry) / controls;
    const scheduledMs = Math.min(
      scheduledFloor,
      Math.max(cadence.pollMs, rounded((6 * YEAR_MS) / controlBudget)),
    );
    const assessmentMs = Math.max(
      cadence.pollMs,
      Math.min(
        cadence.controlAuditMs,
        rounded((5 * YEAR_MS) / (controlBudget - telemetry)),
      ),
    );
    const reservedAnnual = Math.ceil(
      monitors * telemetry +
        controls *
          Math.max(
            (6 * YEAR_MS) / scheduledMs,
            telemetry +
              (5 * YEAR_MS) / Math.min(assessmentMs, cadence.controlAuditMs),
          ),
    );
    if (reservedAnnual <= planningLimit)
      return {
        fits: true,
        planningLimit,
        reservedAnnual,
        monitorMs,
        scheduledMs,
        assessmentMs,
      };
  }
  return {
    fits: false,
    planningLimit,
    reservedAnnual: Math.ceil(
      (monitors * YEAR_MS) / 1800_000 +
        controls *
          Math.max(
            auditFloor + YEAR_MS / 1800_000,
            (6 * YEAR_MS) / scheduledFloor,
          ),
    ),
    monitorMs: 1800_000,
    scheduledMs: scheduledFloor,
    assessmentMs: Math.max(cadence.pollMs, cadence.controlAuditMs),
  };
}

export class ApiCapacityError extends Error {
  constructor() {
    super("Shared API capacity cannot support another control workspace");
    this.name = "ApiCapacityError";
  }
}
