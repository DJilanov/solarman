import { randomUUID } from "node:crypto";
import { observationIdentity, observationBinding } from "./policy-identity.mjs";
export { observationIdentity, observationBinding } from "./policy-identity.mjs";
import { AccountSecurity, SecurityError } from "./account-security.mjs";
import { requireActiveTenant } from "./tenant-lifecycle.mjs";
import { TELEMETRY_MAX_AGE_MS } from "./telemetry.mjs";
/** @typedef {import('./policy-identity.mjs').ObservationIdentityInput} ObservationIdentityInput */
/** @typedef {import('./policy-identity.mjs').ObservationIdentity} ObservationIdentity */

/** @typedef {{id:string,at:string,receivedAt:string,samplingSeconds:number,soc:number,pvW:number,loadW:number,gridW:number,batteryW:number,source:'provider'|'register'}} ObservationSample */
/** @typedef {{count:number,first:ObservationSample|null,last:ObservationSample|null,observedAt:string|null}} ObservationEvidence */
/** @typedef {{version:1,accepted:number,rejected:number,firstAt:string|null,last:ObservationSample|null,coveredSeconds:number,solarSeen:boolean,nightSeen:boolean,approach:ObservationSample|null,solar:ObservationEvidence,discharge:ObservationEvidence,gridCharge:ObservationEvidence,gridStop:ObservationEvidence}} ObservationProgress */
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

/** @returns {ObservationEvidence} */
function emptyEvidence() {
  return { count: 0, first: null, last: null, observedAt: null };
}
/** @returns {ObservationProgress} */
export function emptyObservationProgress() {
  return {
    version: 1,
    accepted: 0,
    rejected: 0,
    firstAt: null,
    last: null,
    coveredSeconds: 0,
    solarSeen: false,
    nightSeen: false,
    approach: null,
    solar: emptyEvidence(),
    discharge: emptyEvidence(),
    gridCharge: emptyEvidence(),
    gridStop: emptyEvidence(),
  };
}

/** @param {Record<string,unknown>} row @returns {ObservationSample|null} */
function sample(row) {
  if (
    !["soc", "pv_w", "load_w", "grid_w", "battery_w", "sampling_seconds"].every(
      (key) => typeof row[key] === "number",
    )
  )
    return null;
  if (
    (!(row.observed_at instanceof Date) &&
      typeof row.observed_at !== "string") ||
    (!(row.received_at instanceof Date) && typeof row.received_at !== "string")
  )
    return null;
  const at = new Date(row.observed_at).getTime(),
    received = new Date(row.received_at).getTime();
  const values = [
    "soc",
    "pv_w",
    "load_w",
    "grid_w",
    "battery_w",
    "sampling_seconds",
  ].map((key) => Number(row[key]));
  if (
    !Number.isFinite(at) ||
    !Number.isFinite(received) ||
    received > Date.now() + 30000 ||
    received - at < -30000 ||
    received - at > TELEMETRY_MAX_AGE_MS ||
    !values.every(Number.isFinite) ||
    !["provider", "register"].includes(row.reading_source) ||
    !/^\d{1,20}$/.test(String(row.id))
  )
    return null;
  const [soc, pvW, loadW, gridW, batteryW, samplingSeconds] = values;
  if (
    !Number.isInteger(soc) ||
    soc < 0 ||
    soc > 100 ||
    pvW < 0 ||
    pvW > 100000 ||
    loadW < 0 ||
    loadW > 100000 ||
    Math.abs(gridW) > 100000 ||
    Math.abs(batteryW) > 30000 ||
    !Number.isInteger(samplingSeconds) ||
    samplingSeconds < 30 ||
    samplingSeconds > 1800
  )
    return null;
  return {
    id: String(row.id),
    at: new Date(at).toISOString(),
    receivedAt: new Date(received).toISOString(),
    samplingSeconds,
    soc,
    pvW,
    loadW,
    gridW,
    batteryW,
    source: row.reading_source,
  };
}

/** @param {ObservationEvidence} previous @param {ObservationSample} current @param {boolean} qualifies @param {'rise'|'fall'|'none'} direction @returns {ObservationEvidence} */
function evidence(previous, current, qualifies, direction = "none") {
  if (previous.observedAt) return previous;
  if (!qualifies) return emptyEvidence();
  const first = previous.first ?? current,
    count = previous.count + 1;
  const changed =
    direction === "rise"
      ? current.soc > first.soc
      : direction === "fall"
        ? current.soc < first.soc
        : true;
  return {
    count,
    first,
    last: current,
    observedAt: count >= 2 && changed ? current.at : null,
  };
}

/** @param {ObservationProgress} previous @param {Record<string,unknown>} row @param {string} startedAt @param {string} timezone @returns {ObservationProgress} */
export function advanceObservation(previous, row, startedAt, timezone) {
  const next = structuredClone(previous),
    current = sample(row);
  if (
    !current ||
    Date.parse(current.at) < Date.parse(startedAt) ||
    (next.last && Date.parse(current.at) <= Date.parse(next.last.at))
  ) {
    next.rejected++;
    return next;
  }
  const gap = next.last
    ? (Date.parse(current.at) - Date.parse(next.last.at)) / 1000
    : 0;
  const continuous =
    next.last &&
    gap <= 2 * Math.max(next.last.samplingSeconds, current.samplingSeconds);
  if (!continuous) {
    for (const key of ["solar", "discharge", "gridCharge", "gridStop"])
      if (!next[key].observedAt) next[key] = emptyEvidence();
    next.approach = null;
  }
  if (continuous)
    next.coveredSeconds += Math.min(
      gap,
      Math.max(next.last.samplingSeconds, current.samplingSeconds),
    );
  next.accepted++;
  next.firstAt ??= current.at;
  next.last = current;
  next.solarSeen ||= current.pvW >= 500;
  const hour = Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      hour: "2-digit",
      hourCycle: "h23",
    }).format(new Date(current.at)),
  );
  next.nightSeen ||= (hour >= 20 || hour < 6) && current.pvW <= 100;
  const solar =
    current.soc > 50 &&
    current.soc < 100 &&
    current.pvW - current.loadW >= 500 &&
    current.batteryW <= -250 &&
    current.gridW <= 250;
  const discharge =
    current.soc > 50 &&
    current.loadW - current.pvW >= 250 &&
    current.batteryW >= 250;
  const gridCharge =
    current.soc < 50 &&
    current.pvW <= 100 &&
    current.batteryW <= -1700 &&
    current.batteryW >= -2300 &&
    current.gridW - current.loadW >= 1000;
  next.solar = evidence(next.solar, current, solar, "rise");
  next.discharge = evidence(next.discharge, current, discharge, "fall");
  next.gridCharge = evidence(next.gridCharge, current, gridCharge);
  if (gridCharge) next.approach = current;
  const nearApproach =
    next.approach &&
    (Date.parse(current.at) - Date.parse(next.approach.at)) / 1000 <=
      2 * Math.max(next.approach.samplingSeconds, current.samplingSeconds);
  next.gridStop = evidence(
    next.gridStop,
    current,
    Boolean(
      next.gridCharge.observedAt &&
        // Only entry needs a recent approach; subsequent stop readings must stay continuous.
        (nearApproach || next.gridStop.count > 0) &&
        current.soc === 50 &&
        current.pvW <= 100 &&
        current.batteryW >= -100,
    ),
  );
  return next;
}

/** @param {ObservationProgress} progress @returns {{spanSeconds:number,coverage:number,cycleObserved:boolean}} */
export function observationWindow(progress) {
  const spanSeconds =
    progress.firstAt && progress.last
      ? Math.max(
          0,
          (Date.parse(progress.last.at) - Date.parse(progress.firstAt)) / 1000,
        )
      : 0;
  const coverage = spanSeconds
    ? Math.min(1, progress.coveredSeconds / spanSeconds)
    : 0;
  return {
    spanSeconds,
    coverage,
    cycleObserved:
      spanSeconds >= 86400 &&
      coverage >= 0.9 &&
      progress.solarSeen &&
      progress.nightSeen,
  };
}

/** @param {import('pg').Pool|import('pg').PoolClient} client @returns {Promise<void>} */
export async function quarantineObservationRuns(client) {
  await client.query(
    "UPDATE policy_observation_runs SET state='invalidated',reason='restore',ended_at=clock_timestamp() WHERE state='observing'",
  );
}

/** @param {unknown} value @returns {ObservationProgress} */
export function parseObservationProgress(value) {
  if (
    !value ||
    typeof value !== "object" ||
    value.version !== 1 ||
    !Number.isSafeInteger(value.accepted) ||
    value.accepted < 0 ||
    !Number.isSafeInteger(value.rejected) ||
    value.rejected < 0 ||
    !Number.isFinite(value.coveredSeconds) ||
    value.coveredSeconds < 0 ||
    typeof value.solarSeen !== "boolean" ||
    typeof value.nightSeen !== "boolean" ||
    (value.firstAt !== null &&
      (typeof value.firstAt !== "string" ||
        !Number.isFinite(Date.parse(value.firstAt)))) ||
    ![value.last, value.approach].every(
      (item) =>
        item === null ||
        (item &&
          typeof item === "object" &&
          typeof item.at === "string" &&
          Number.isFinite(Date.parse(item.at))),
    ) ||
    !["solar", "discharge", "gridCharge", "gridStop"].every(
      (key) =>
        value[key] &&
        Number.isSafeInteger(value[key].count) &&
        value[key].count >= 0 &&
        (value[key].observedAt === null ||
          (typeof value[key].observedAt === "string" &&
            Number.isFinite(Date.parse(value[key].observedAt)))),
    )
  )
    throw new Error("Invalid saved observation progress");
  return value;
}

export class PolicyObservations {
  /** @param {import('pg').Pool} pool */
  constructor(pool) {
    this.pool = pool;
    this.security = new AccountSecurity(pool);
    this.timer = null;
    this.pending = null;
    this.stopping = false;
    this.started = false;
  }
  /** @param {object} runtime @returns {ObservationIdentity|null} */
  identity(runtime) {
    return observationIdentity({
      accountId: runtime.account?.id,
      device: runtime.device,
      profile: runtime.account?.profile,
      timezone: runtime.timezone,
      firmware: runtime.firmware,
    });
  }
  /** @param {object} runtime @returns {boolean} */
  canStart(runtime) {
    const status = runtime.status();
    return (
      status.lifecycle === "active" &&
      status.control.verificationStatus.state === "verified" &&
      status.control.canVerify &&
      !status.control.reasons.some(
        (reason) =>
          !["server", "workspace", "capacity", "commissioning"].includes(
            reason.code,
          ),
      ) &&
      Boolean(this.identity(runtime))
    );
  }
  /** @param {string} tenantId @param {object} runtime @param {string|null} [id] @returns {Promise<object>} */
  async status(tenantId, runtime, id = null) {
    if (id && !UUID.test(id))
      throw new SecurityError(400, "Choose a valid observation run");
    const history = (
      await this.pool.query(
        "SELECT id,state,reason,started_at,ended_at FROM policy_observation_runs WHERE tenant_id=$1 ORDER BY started_at DESC,id DESC LIMIT 20",
        [tenantId],
      )
    ).rows;
    const row = (
      await this.pool.query(
        `SELECT * FROM policy_observation_runs WHERE tenant_id=$1 AND($2::uuid IS NULL OR id=$2) ORDER BY started_at DESC,id DESC LIMIT 1`,
        [tenantId, id],
      )
    ).rows[0];
    if (id && !row) throw new SecurityError(404, "Observation run not found");
    const identity = this.identity(runtime);
    return {
      canStart: this.canStart(runtime),
      activeRunId: history.find((run) => run.state === "observing")?.id ?? null,
      identity,
      run: row
        ? {
            id: row.id,
            state: row.state,
            reason: row.reason,
            startedAt: row.started_at,
            endedAt: row.ended_at,
            checkedAt: row.checked_at,
            failedAt: row.failed_at,
            identity: row.identity,
            verification: row.verification,
            currentBinding: identity
              ? row.binding === observationBinding(identity)
              : null,
            progress: parseObservationProgress(row.progress),
            window: observationWindow(parseObservationProgress(row.progress)),
          }
        : null,
      history,
    };
  }
  /** @param {{id:string,tenant_id:string,token_hash:string}} session @param {object} runtime @param {{action:unknown,id?:unknown}} body @returns {Promise<void>} */
  async change(session, runtime, body) {
    if (!["start", "stop", "check"].includes(body.action))
      throw new SecurityError(400, "Choose a valid observation action");
    if (
      body.action !== "start" &&
      (typeof body.id !== "string" || !UUID.test(body.id))
    )
      throw new SecurityError(400, "Choose a valid observation run");
    await this.security.withUser(session.id, async (client, user) => {
      await this.security.activeSession(client, session);
      if (user.tenant_id !== session.tenant_id)
        throw new SecurityError(401, "Sign in to continue");
      const control = (
        await client.query(
          "SELECT verification FROM controller_state WHERE tenant_id=$1 FOR UPDATE",
          [session.tenant_id],
        )
      ).rows[0];
      if (body.action === "start") {
        await requireActiveTenant(client, session.tenant_id);
        const account = (
          await client.query(
            "SELECT id,device_sn,profile,timezone FROM solarman_accounts WHERE tenant_id=$1",
            [session.tenant_id],
          )
        ).rows[0];
        const identity = this.identity(runtime),
          saved = control?.verification;
        if (
          !this.canStart(runtime) ||
          !saved?.passed ||
          saved.checkedAt !== runtime.verification?.checkedAt ||
          !identity ||
          account?.id !== identity.accountId ||
          account.device_sn !== identity.device ||
          account.profile !== identity.profile ||
          account.timezone !== identity.timezone
        )
          throw new SecurityError(
            409,
            "Fresh device verification is required before starting observations",
          );
        const active = (
          await client.query(
            "SELECT 1 FROM policy_observation_runs WHERE tenant_id=$1 AND state='observing'",
            [session.tenant_id],
          )
        ).rowCount;
        if (active)
          throw new SecurityError(409, "An observation run is already active");
        const cursor = (
          await client.query(
            "SELECT COALESCE(max(id),0)::text AS id FROM measurements WHERE tenant_id=$1",
            [session.tenant_id],
          )
        ).rows[0].id;
        await client.query(
          "INSERT INTO policy_observation_runs(id,tenant_id,account_id,device,binding,identity,verification,created_by,cursor_id,progress) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
          [
            randomUUID(),
            session.tenant_id,
            identity.accountId,
            identity.device,
            observationBinding(identity),
            identity,
            saved,
            user.id,
            cursor,
            emptyObservationProgress(),
          ],
        );
      } else {
        const result = await client.query(
          "UPDATE policy_observation_runs SET state=CASE WHEN $3='stop' AND state='observing' THEN 'stopped' ELSE state END,ended_at=CASE WHEN $3='stop' AND state='observing' THEN clock_timestamp() ELSE ended_at END WHERE tenant_id=$1 AND id=$2 RETURNING id",
          [session.tenant_id, body.id, body.action],
        );
        if (!result.rowCount)
          throw new SecurityError(404, "Observation run not found");
      }
    });
    if (body.action === "check") await this.process(session.tenant_id, body.id);
  }
  /** @param {string} tenantId @param {string} id @returns {Promise<void>} */
  async process(tenantId, id) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL statement_timeout='2s'");
      await client.query("SET LOCAL lock_timeout='200ms'");
      const run = (
        await client.query(
          "SELECT * FROM policy_observation_runs WHERE tenant_id=$1 AND id=$2 AND state='observing' FOR UPDATE",
          [tenantId, id],
        )
      ).rows[0];
      if (!run) {
        await client.query("ROLLBACK");
        return;
      }
      const rows = (
        await client.query(
          "SELECT id,observed_at,received_at,reading_source,sampling_seconds,soc,pv_w,load_w,grid_w,battery_w,control_binding FROM measurements WHERE tenant_id=$1 AND account_id=$2 AND device=$3 AND id>$4 ORDER BY id LIMIT 500",
          [tenantId, run.account_id, run.device, run.cursor_id],
        )
      ).rows;
      let next = parseObservationProgress(run.progress),
        cursor = run.cursor_id,
        invalid = false;
      for (const row of rows) {
        cursor = row.id;
        if (new Date(row.observed_at) < run.started_at) continue;
        if (row.control_binding !== run.binding) {
          invalid = true;
          break;
        }
        next = advanceObservation(
          next,
          row,
          run.started_at.toISOString(),
          run.identity.timezone,
        );
      }
      await client.query(
        "UPDATE policy_observation_runs SET cursor_id=$3,progress=$4,checked_at=clock_timestamp(),failed_at=null,state=CASE WHEN $5 THEN 'invalidated' ELSE state END,reason=CASE WHEN $5 THEN 'binding_changed' ELSE reason END,ended_at=CASE WHEN $5 THEN clock_timestamp() ELSE ended_at END WHERE tenant_id=$1 AND id=$2",
        [tenantId, id, cursor, next, invalid],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL statement_timeout='1s'");
        await client.query("SET LOCAL lock_timeout='200ms'");
        await client.query(
          "UPDATE policy_observation_runs SET failed_at=clock_timestamp(),checked_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2",
          [tenantId, id],
        );
        await client.query("COMMIT");
      } catch {
        await client.query("ROLLBACK");
        console.error(
          JSON.stringify({ event: "policy_observation_status_unavailable" }),
        );
      }
      throw error;
    } finally {
      client.release();
    }
  }
  /** @param {string} tenantId @param {string|null} binding @returns {Promise<void>} */
  async checkBinding(tenantId, binding) {
    await this.pool.query(
      "UPDATE policy_observation_runs SET state='invalidated',reason='binding_changed',ended_at=clock_timestamp() WHERE tenant_id=$1 AND state='observing' AND binding IS DISTINCT FROM $2",
      [tenantId, binding],
    );
  }
  /** @returns {Promise<void>} */
  runOnce() {
    if (this.pending) return this.pending;
    this.pending = (async () => {
      const due = (
        await this.pool.query(
          "SELECT tenant_id,id FROM policy_observation_runs WHERE state='observing' AND(checked_at IS NULL OR checked_at<clock_timestamp()-interval '1 minute') ORDER BY checked_at NULLS FIRST,started_at LIMIT 10",
        )
      ).rows;
      for (const row of due) {
        try {
          await this.process(row.tenant_id, row.id);
        } catch {
          console.error(
            JSON.stringify({ event: "policy_observation_pending" }),
          );
        }
      }
    })().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }
  /** @returns {void} */
  start() {
    if (this.started) return;
    this.started = true;
    const loop = async () => {
      if (this.stopping) return;
      try {
        await this.runOnce();
      } catch {
        console.error(JSON.stringify({ event: "policy_observation_pending" }));
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
}
