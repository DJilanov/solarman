/** @typedef {{soc: number, pvW: number, loadW: number, gridW: number, batteryW: number}} PowerReading */

export class Supervision {
  /** @param {{auditMs: number, retryMs: number}} options */
  constructor(options) {
    this.options = options;
    this.lastNativeAt = null;
    this.nextDecisionAt = 0;
    this.lastDecision = null;
    this.lastUploadAt = 0;
    this.candidate = null;
    this.issue = null;
    this.checkedIssue = null;
  }

  /** @param {PowerReading} reading @param {Date} collectedAt @returns {void} */
  observe(reading, collectedAt) {
    const at = collectedAt.getTime();
    if (!Number.isFinite(at) || at <= this.lastUploadAt) return;
    this.lastUploadAt = at;
    const code =
      reading.soc >= 52 &&
      reading.loadW - reading.pvW > 250 &&
      reading.batteryW < 100 &&
      reading.gridW > 250
        ? "battery_not_supporting_home"
        : reading.soc >= 50 &&
            reading.soc < 99 &&
            reading.pvW - reading.loadW > 500 &&
            reading.batteryW > -100
          ? "solar_not_charging"
          : null;
    if (!code) {
      this.candidate = null;
      this.issue = null;
      return;
    }
    this.candidate =
      this.candidate?.code === code
        ? { ...this.candidate, count: this.candidate.count + 1 }
        : { code, count: 1, firstAt: at };
    if (this.candidate.count >= 2)
      this.issue = {
        key: `${code}:${this.candidate.firstAt}`,
        code,
        observedAt: new Date(at).toISOString(),
        message:
          code === "battery_not_supporting_home"
            ? "The grid is supplying the home above the reserve with little or no battery support. Check inverter settings and BMS limits."
            : "Solar surplus is available, but the battery is not charging. Check inverter settings and BMS limits.",
      };
  }

  /** @param {PowerReading} reading @param {{owned: boolean, verified: boolean, force?: boolean, now?: number}} context @returns {{native: boolean, reason: string}} */
  plan(reading, { owned, verified, force = false, now = Date.now() }) {
    if (
      force ||
      owned ||
      !verified ||
      this.lastNativeAt === null ||
      now - this.lastNativeAt >= this.options.auditMs
    )
      return { native: true, reason: "native_audit" };
    if (this.issue && this.issue.key !== this.checkedIssue)
      return { native: true, reason: "observed_policy_deviation" };
    if (reading.soc >= 50) return { native: false, reason: "reserve_reached" };
    if (reading.pvW - reading.loadW >= 1800)
      return { native: false, reason: "solar_can_charge" };
    if (reading.batteryW <= -1800)
      return { native: false, reason: "native_charging" };
    return now >= this.nextDecisionAt
      ? { native: true, reason: "topup_assessment" }
      : { native: false, reason: this.lastDecision ?? "topup_waiting" };
  }

  /** @param {string | null} reason @param {number} [now] @returns {void} */
  checked(reason, now = Date.now()) {
    this.lastNativeAt = now;
    this.nextDecisionAt = now + this.options.retryMs;
    this.lastDecision = reason;
    this.checkedIssue = this.issue?.key ?? null;
  }

  /** @returns {{auditSeconds: number, lastNativeAt: string | null, nextAuditAt: string | null, issue: {code: string, message: string, observedAt: string} | null}} */
  status() {
    return {
      auditSeconds: this.options.auditMs / 1000,
      lastNativeAt:
        this.lastNativeAt === null
          ? null
          : new Date(this.lastNativeAt).toISOString(),
      nextAuditAt:
        this.lastNativeAt === null
          ? null
          : new Date(this.lastNativeAt + this.options.auditMs).toISOString(),
      issue: this.issue
        ? {
            code: this.issue.code,
            message: this.issue.message,
            observedAt: this.issue.observedAt,
          }
        : null,
    };
  }
}
