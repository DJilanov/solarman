import { quarantineEnergy } from "./energy-lifecycle.mjs";
import { randomUUID } from "node:crypto";
import { AccountSecurity, SecurityError } from "./account-security.mjs";
import { requireActiveTenant } from "./tenant-lifecycle.mjs";
import {
  observationIdentity,
  observationBinding,
  observationWindow,
  parseObservationProgress,
} from "./policy-observations.mjs";
import { currentCommissioning } from "./commissioning-state.mjs";
import { reviewCommissioningHistory } from "./commissioning-history.mjs";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export const ATTENDED_MINUTES = 30;

/** @param {object|null} evidence @returns {{code:string,passed:boolean}[]} */
export function commissioningRequirements(evidence) {
  const p = evidence?.observation?.progress;
  return [
    ...["solar", "discharge", "gridCharge", "gridStop"].map((code) => ({
      code,
      passed: Boolean(p?.[code]?.observedAt),
    })),
    {
      code: "dayNight",
      passed: Boolean(
        p && observationWindow(parseObservationProgress(p)).cycleObserved,
      ),
    },
    { code: "recovery", passed: Boolean(evidence?.recovery?.commandId) },
  ];
}

/** @param {import('pg').Pool|import('pg').PoolClient} client @param {object} run @param {string|null} [commandId] @returns {Promise<{id:string,action:string,completed_at:Date}[]>} */
async function verifiedRecoveryCommands(client, run, commandId = null) {
  return (
    await client.query(
      `SELECT c.id,c.action,c.completed_at FROM command_executions c
      WHERE c.tenant_id=$1 AND c.account_id=$2 AND c.device=$3 AND c.created_at>=$4
      AND ($5::uuid IS NULL OR c.id=$5) AND c.action IN('stop','pause','disable_controls','commission_recovery')
      AND c.status='succeeded' AND c.completed_at IS NOT NULL
      AND EXISTS(SELECT 1 FROM inverter_write_intents w WHERE w.tenant_id=c.tenant_id
        AND w.execution_id=c.id AND w.account_id=c.account_id AND w.device=c.device
        AND w.operation='disable' AND w.status='verified'
        AND (c.action<>'commission_recovery' OR EXISTS(
          SELECT 1 FROM inverter_write_intents e WHERE e.tenant_id=w.tenant_id AND e.execution_id=c.id
          AND e.account_id=w.account_id AND e.device=w.device AND e.operation='enable' AND e.status='verified'
          AND e.verified_at IS NOT NULL AND e.verified_at<=w.created_at)))
      ORDER BY c.completed_at DESC,c.id DESC LIMIT 20`,
      [run.tenant_id, run.account_id, run.device, run.created_at, commandId],
    )
  ).rows;
}

/** @param {import('pg').PoolClient} client @param {object} run @param {string} action @param {object} [detail] @returns {Promise<void>} */
async function event(client, run, action, detail = {}) {
  await client.query(
    "INSERT INTO commissioning_events(id,tenant_id,run_id,revision,action,detail) VALUES($1,$2,$3,$4,$5,$6)",
    [randomUUID(), run.tenant_id, run.id, run.revision, action, detail],
  );
}

/** @param {import('pg').PoolClient} client @param {string} tenantId @returns {Promise<void>} */
async function pause(client, tenantId) {
  await client.query(
    `INSERT INTO device_control_state(tenant_id,account_id,device,state)
    SELECT a.tenant_id,a.id,a.device_sn,'cleanup-required' FROM solarman_accounts a JOIN controller_state c ON c.tenant_id=a.tenant_id
    WHERE a.tenant_id=$1 AND a.device_sn IS NOT NULL AND c.control_enabled
    ON CONFLICT(tenant_id,account_id,device) DO UPDATE SET state='cleanup-required',updated_at=clock_timestamp()`,
    [tenantId],
  );
  await client.query(
    "UPDATE controller_state SET paused=true,manual_topup=false,topup_expires_at=null,control_enabled=false,control_epoch=control_epoch+1,updated_at=clock_timestamp() WHERE tenant_id=$1",
    [tenantId],
  );
  await client.query(
    "UPDATE device_control_state SET state='cleanup-required',updated_at=clock_timestamp() WHERE tenant_id=$1 AND state<>'clear'",
    [tenantId],
  );
}

export class Commissioning {
  /** @param {import('pg').Pool} pool @param {object} hub */
  constructor(pool, hub) {
    this.pool = pool;
    this.hub = hub;
    this.security = new AccountSecurity(pool);
    this.timer = null;
    this.pending = null;
    this.stopping = false;
    this.started = false;
  }

  /** @param {object} runtime @returns {object|null} */
  identity(runtime) {
    return observationIdentity({
      accountId: runtime.account?.id,
      device: runtime.device,
      profile: runtime.account?.profile,
      timezone: runtime.timezone,
      firmware: runtime.firmware,
    });
  }

  /** @param {string} tenantId @param {object} runtime @returns {Promise<object>} */
  async status(tenantId, runtime) {
    const run = await currentCommissioning(this.pool, tenantId);
    const identity = this.identity(runtime);
    const matching = Boolean(
      run && identity && run.binding === observationBinding(identity),
    );
    const [history, events, recoveryCommands, observation] = await Promise.all([
      this.pool
        .query(
          "SELECT id,state,reason,created_at,ended_at FROM control_commissioning WHERE tenant_id=$1 ORDER BY created_at DESC,id DESC LIMIT 20",
          [tenantId],
        )
        .then((result) => result.rows),
      run
        ? this.pool
            .query(
              "SELECT action,revision::text,detail,created_at FROM commissioning_events WHERE tenant_id=$1 AND run_id=$2 ORDER BY revision DESC LIMIT 25",
              [tenantId, run.id],
            )
            .then((result) => result.rows)
        : [],
      matching ? verifiedRecoveryCommands(this.pool, run) : [],
      matching
        ? this.pool
            .query(
              "SELECT id,binding,state,failed_at,checked_at,progress FROM policy_observation_runs WHERE tenant_id=$1 ORDER BY started_at DESC,id DESC LIMIT 1",
              [tenantId],
            )
            .then((result) => result.rows[0])
        : null,
    ]);
    return {
      identity,
      canPrepare: this.canPrepare(runtime),
      attendedMinutes: ATTENDED_MINUTES,
      availableObservation:
        observation &&
        observation.binding === run.binding &&
        observation.state !== "invalidated" &&
        !observation.failed_at
          ? {
              id: observation.id,
              checkedAt: observation.checked_at,
              requirements: commissioningRequirements({
                observation: {
                  progress: parseObservationProgress(observation.progress),
                },
              }),
            }
          : null,
      recoveryCommands: recoveryCommands.map((command) => ({
        id: command.id,
        action: command.action,
        completedAt: command.completed_at,
      })),
      run: run
        ? {
            id: run.id,
            state: run.state,
            revision: String(run.revision),
            createdAt: run.created_at,
            updatedAt: run.updated_at,
            attendedUntil: run.attended_until,
            currentBinding: identity
              ? run.binding === observationBinding(identity)
              : null,
            identity: run.identity,
            verification: run.verification,
            evidence: run.evidence,
            requirements: commissioningRequirements(run.evidence),
            events,
          }
        : null,
      history,
    };
  }

  /** @param {object} runtime @returns {boolean} */
  canPrepare(runtime) {
    const status = runtime.status();
    return (
      status.lifecycle === "active" &&
      status.paused &&
      !status.manualTopup &&
      status.control.verificationStatus.state === "verified" &&
      Boolean(this.identity(runtime)) &&
      !status.control.reasons.some(
        (r) =>
          !["server", "workspace", "capacity", "commissioning"].includes(
            r.code,
          ),
      )
    );
  }

  /** @param {string} tenantId @param {object} runtime @returns {Promise<object>} */
  async reviewHistory(tenantId, runtime) {
    const run = await currentCommissioning(this.pool, tenantId);
    const identity = this.identity(runtime);
    if (!run || !identity || run.binding !== observationBinding(identity))
      throw new SecurityError(409, "The commissioning device binding is no longer current");
    const review = await reviewCommissioningHistory(this.pool, run);
    return {
      ...review,
      requirements: commissioningRequirements({ observation: review }),
    };
  }

  /** @param {{id:string,tenant_id:string,token_hash:string}} session @param {object} runtime @param {object} body @returns {Promise<void>} */
  async change(session, runtime, body) {
    if (
      ![
        "create",
        "attend",
        "end",
        "evidence",
        "approve",
        "invalidate",
      ].includes(body.action) ||
      (body.action !== "create" &&
        (typeof body.id !== "string" ||
          !UUID.test(body.id) ||
          typeof body.revision !== "string" ||
          !/^\d{1,18}$/.test(body.revision)))
    )
      throw new SecurityError(
        400,
        "Choose a valid commissioning action and revision",
      );
    const hash = await this.security.confirmedPassword(
      session.id,
      body.currentPassword,
    );
    let stopped = false;
    await this.security.withUser(session.id, async (client, user) => {
      await this.security.activeSession(client, session);
      if (user.tenant_id !== session.tenant_id || user.password_hash !== hash)
        throw new SecurityError(
          409,
          "Your account changed. Refresh this page and try again.",
        );
      const control = (
        await client.query(
          "SELECT * FROM controller_state WHERE tenant_id=$1 FOR UPDATE",
          [session.tenant_id],
        )
      ).rows[0];
      await requireActiveTenant(client, session.tenant_id);
      const account = (
        await client.query(
          "SELECT id,device_sn,profile,timezone FROM solarman_accounts WHERE tenant_id=$1",
          [session.tenant_id],
        )
      ).rows[0];
      const identity = this.identity(runtime);
      const matching =
        identity &&
        account?.id === identity.accountId &&
        account.device_sn === identity.device &&
        account.profile === identity.profile &&
        account.timezone === identity.timezone &&
        control.verification?.passed &&
        control.verification.checkedAt === runtime.verification?.checkedAt;
      let run = await currentCommissioning(client, session.tenant_id);
      if (body.action === "create") {
        if (run)
          throw new SecurityError(
            409,
            "A commissioning run is already current",
          );
        if (
          !matching ||
          !this.canPrepare(runtime) ||
          !control.paused ||
          control.manual_topup
        )
          throw new SecurityError(
            409,
            "Pause automation and verify the device before commissioning",
          );
        run = (
          await client.query(
            "INSERT INTO control_commissioning(id,tenant_id,account_id,device,binding,identity,verification,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *",
            [
              randomUUID(),
              session.tenant_id,
              identity.accountId,
              identity.device,
              observationBinding(identity),
              identity,
              control.verification,
              user.id,
            ],
          )
        ).rows[0];
        await event(client, run, "created");
        return;
      }
      if (!run || run.id !== body.id || String(run.revision) !== body.revision)
        throw new SecurityError(
          409,
          "Commissioning changed. Refresh its status before trying again.",
        );
      if (
        run.state === "approved" &&
        !["end", "invalidate"].includes(body.action)
      )
        throw new SecurityError(
          409,
          "Commissioning changed. Refresh its status before trying again.",
        );
      if (
        !["invalidate", "end"].includes(body.action) &&
        (!matching || observationBinding(identity) !== run.binding)
      )
        throw new SecurityError(
          409,
          "The commissioning device binding is no longer current",
        );
      let state = run.state,
        until = run.attended_until,
        evidence = run.evidence,
        detail = {};
      let action = body.action;
      if (action === "attend") {
        if (
          run.state !== "preparing" ||
          !this.canPrepare(runtime) ||
          !runtime.status().control.canCommission ||
          !control.paused ||
          control.manual_topup ||
          body.attending !== true
        )
          throw new SecurityError(
            409,
            "Fresh verification, host permission and attended-test confirmation are required",
          );
        state = "attending";
        until = new Date(Date.now() + ATTENDED_MINUTES * 60000);
        action = "attended";
      } else if (action === "end" || action === "invalidate") {
        await quarantineEnergy(
          client,
          session.tenant_id,
          "commissioning_changed",
        );
        state = action === "end" ? "preparing" : "invalidated";
        until = null;
        await pause(client, session.tenant_id);
        stopped = true;
        action = action === "end" ? "ended" : "invalidated";
      } else if (action === "evidence") {
        if (body.observationSource === "stored-measurements") {
          if (typeof body.historyThroughId !== "string" || typeof body.historyHash !== "string")
            throw new SecurityError(400, "Review stored measurements before saving their evidence");
          const review = await reviewCommissioningHistory(client, run, body.historyThroughId);
          if (review.hash !== body.historyHash)
            throw new SecurityError(409, "Historical readings changed. Review them again before saving");
          evidence = { ...evidence, observation: { id: randomUUID(), ...review } };
          detail = { observationSource: review.source, historyHash: review.hash, sampleCount: review.sampleCount };
        } else {
          if (body.observationSource !== undefined)
            throw new SecurityError(400, "Choose a valid observation evidence source");
          if (
            typeof body.observationRunId !== "string" ||
            !UUID.test(body.observationRunId)
          )
            throw new SecurityError(
              400,
              "Choose an observation run for commissioning evidence",
            );
          const observation = (
            await client.query(
              "SELECT id,binding,state,failed_at,progress,started_at,checked_at FROM policy_observation_runs WHERE tenant_id=$1 AND id=$2 FOR SHARE",
              [session.tenant_id, body.observationRunId],
            )
          ).rows[0];
          if (
            !observation ||
            observation.binding !== run.binding ||
            observation.state === "invalidated" ||
            observation.failed_at
          )
            throw new SecurityError(
              409,
              "Use valid observations from the current device binding",
            );
          evidence = {
            ...evidence,
            observation: {
              id: observation.id,
              startedAt: observation.started_at,
              checkedAt: observation.checked_at,
              progress: parseObservationProgress(observation.progress),
            },
          };
        }
        if (body.recoveryCommandId) {
          if (
            typeof body.recoveryCommandId !== "string" ||
            !UUID.test(body.recoveryCommandId)
          )
            throw new SecurityError(400, "Choose a verified recovery command");
          const [recovery] = await verifiedRecoveryCommands(
            client,
            run,
            body.recoveryCommandId,
          );
          if (!recovery)
            throw new SecurityError(409, "Choose a verified recovery command");
          evidence.recovery = {
            commandId: recovery.id,
            completedAt: recovery.completed_at,
          };
        }
      } else if (action === "approve") {
        if (
          run.state !== "preparing" ||
          !this.canPrepare(runtime) ||
          commissioningRequirements(evidence).some((r) => !r.passed)
        )
          throw new SecurityError(
            409,
            "Physical policy and recovery evidence are required before approval",
          );
        state = "approved";
        action = "approved";
      }
      run = (
        await client.query(
          "UPDATE control_commissioning SET state=$3,attended_until=$4,evidence=$5,revision=revision+1,updated_at=clock_timestamp(),ended_at=CASE WHEN $3='invalidated' THEN clock_timestamp() ELSE null END,reason=CASE WHEN $3='invalidated' THEN 'operator' ELSE reason END WHERE tenant_id=$1 AND id=$2 RETURNING *",
          [session.tenant_id, run.id, state, until, evidence],
        )
      ).rows[0];
      await event(client, run, action, detail);
    });
    if (stopped) await this.reconcile(runtime);
    else await runtime.initialize();
  }

  /** @param {object} runtime @returns {Promise<void>} */
  async reconcile(runtime) {
    runtime.inhibitStarts = true;
    runtime.enableEpoch++;
    await runtime.initialize();
    await this.hub.budget.refreshCapacity(runtime.appKey);
    if (runtime.journal.owned) {
      try {
        await runtime.queue(() => runtime.clearScheduledPermission(), 10);
      } catch {
        console.error(
          JSON.stringify({ event: "commissioning_cleanup_pending" }),
        );
      }
    }
  }

  /** @param {boolean} [restarting] @returns {Promise<number>} */
  async expire(restarting = false) {
    let processed = 0;
    for (let index = 0; index < 10; index++) {
      const client = await this.pool.connect();
      let tenantId = null;
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL lock_timeout='500ms'");
        await client.query("SET LOCAL statement_timeout='2s'");
        const candidate = (
          await client.query(
            `SELECT r.tenant_id,r.id FROM control_commissioning r JOIN controller_state c ON c.tenant_id=r.tenant_id
          WHERE r.state='attending' AND($1 OR r.attended_until<=clock_timestamp())
          ORDER BY r.attended_until LIMIT 1 FOR UPDATE OF c SKIP LOCKED`,
            [restarting],
          )
        ).rows[0];
        if (!candidate) {
          await client.query("COMMIT");
          break;
        }
        const run = (
          await client.query(
            "UPDATE control_commissioning SET state='preparing',attended_until=null,revision=revision+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2 AND state='attending' AND($3 OR attended_until<=clock_timestamp()) RETURNING *",
            [candidate.tenant_id, candidate.id, restarting],
          )
        ).rows[0];
        if (run) {
          await pause(client, candidate.tenant_id);
          await event(client, run, "expired", { restart: restarting });
          tenantId = candidate.tenant_id;
          processed++;
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      if (tenantId) {
        const runtime = this.hub.runtimes.get(tenantId);
        if (runtime) await this.reconcile(runtime);
      }
    }
    return processed;
  }

  /** @returns {void} */
  start() {
    if (this.started || this.stopping) return;
    this.started = true;
    const tick = async () => {
      if (this.stopping) return;
      this.pending = this.expire();
      try {
        await this.pending;
      } catch {
        console.error(
          JSON.stringify({ event: "commissioning_expiry_pending" }),
        );
      } finally {
        this.pending = null;
      }
      if (!this.stopping)
        this.timer = setTimeout(() => {
          void tick();
        }, 15000);
    };
    void tick();
  }
  /** @returns {Promise<void>} */
  async stop() {
    this.stopping = true;
    clearTimeout(this.timer);
    await this.pending?.catch(() => {});
  }
}
