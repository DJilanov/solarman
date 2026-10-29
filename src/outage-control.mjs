import { randomUUID } from "node:crypto";
import { BatteryController } from "./controller.mjs";
import { parseFrame } from "./modbus.mjs";
import { AccountSecurity } from "./account-security.mjs";
import { matchingControlFirmware } from "./control-readiness.mjs";
import {
  commissioningAllowed,
  commissioningBinding,
  currentCommissioning,
} from "./commissioning-state.mjs";
import {
  OUTAGE_MAPPING,
  OUTAGE_OPEN_STATES,
  allowedOutageWrite,
  observeOutageHold,
  outageSettingsMatch,
  outageTarget,
  outageTestPassed,
  sameWords,
} from "./outage-policy.mjs";
import { OutageNativeController } from "./outage-native.mjs";
import { providerFirmware } from "./telemetry.mjs";
import { requireActiveTenant } from "./tenant-lifecycle.mjs";

export class OutageError extends Error {
  /** @param {number} status @param {string} message */
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** @param {object|null} row @returns {boolean} */
function open(row) {
  return Boolean(row && OUTAGE_OPEN_STATES.includes(row.state));
}

export class OutageControl {
  /** @param {object} runtime */
  constructor(runtime) {
    this.runtime = runtime;
    this.pool = runtime.pool;
    this.row = null;
    this.approval = null;
    this.context = null;
    this.preparedWrite = null;
    this.recoveryQueued = false;
    this.queued = new Set();
    this.security = new AccountSecurity(this.pool);
  }

  /** @returns {boolean} */
  get active() {
    return open(this.row);
  }

  /** @returns {boolean} */
  get ownsDispatch() {
    return this.context !== null;
  }

  /** @returns {Promise<void>} */
  async load(restarting = false) {
    if (restarting) {
      await this.pool.query(
        "UPDATE outage_preparations SET state=CASE WHEN baseline IS NULL THEN 'failed' ELSE 'recovery-required' END,last_error='interrupted',ended_at=CASE WHEN baseline IS NULL THEN clock_timestamp() ELSE ended_at END,updated_at=clock_timestamp() WHERE tenant_id=$1 AND (state IN('queued','applying','restoring') OR (state='active' AND test))",
        [this.runtime.tenantId],
      );
      await this.pool.query(
        "UPDATE command_executions SET status='interrupted',completed_at=clock_timestamp(),message='Outage request was interrupted; review its current state' WHERE tenant_id=$1 AND action IN('outage_prepare','outage_restore') AND status IN('queued','running')",
        [this.runtime.tenantId],
      );
    }
    this.row =
      (
        await this.pool.query(
          "SELECT * FROM outage_preparations WHERE tenant_id=$1 ORDER BY (state=ANY($2::text[])) DESC,created_at DESC,id DESC LIMIT 1",
          [this.runtime.tenantId, OUTAGE_OPEN_STATES],
        )
      ).rows[0] ?? null;
    const binding = commissioningBinding(
      this.runtime.account,
      this.runtime.verification,
    );
    this.approval = binding
      ? ((
          await this.pool.query(
            "SELECT id,approved_at,proof FROM outage_preparations WHERE tenant_id=$1 AND account_id=$2 AND device=$3 AND binding=$4 AND mapping=$5 AND state='restored' AND test AND approved_at IS NOT NULL ORDER BY approved_at DESC LIMIT 1",
            [
              this.runtime.tenantId,
              this.runtime.account.id,
              this.runtime.device,
              binding,
              OUTAGE_MAPPING,
            ],
          )
        ).rows[0] ?? null)
      : null;
  }

  /** @returns {object} */
  status() {
    const r = this.runtime;
    const ready = r.readiness();
    const binding = commissioningBinding(r.account, r.verification);
    const sameDevice =
      this.row?.account_id === r.account?.id && this.row?.device === r.device;
    return {
      supported: r.account?.profile === "bluesun-bse20kh3",
      minTarget: 50,
      maxTarget: 100,
      acChargeKw: 2,
      solarTargetSoc: 100,
      canPrepare:
        !this.active &&
        ready.canStart &&
        Boolean(this.approval && outageTestPassed(this.approval.proof)),
      canTest:
        !this.active &&
        ready.canCommission &&
        r.controlEnabled &&
        r.commissioningPermitted("attended"),
      canRestore:
        this.active &&
        sameDevice &&
        (!this.row.baseline ||
          (r.account?.profile === "bluesun-bse20kh3" &&
            Boolean(r.client && r.ready && r.hostWritesAllowed))),
      capabilityApproved: Boolean(
        this.approval && outageTestPassed(this.approval.proof),
      ),
      preparation: this.row
        ? {
            id: this.row.id,
            state: this.row.state,
            revision: String(this.row.revision),
            targetSoc: this.row.target_soc,
            test: this.row.test,
            attendedUntil: this.row.attended_until,
            lastVerifiedAt: this.row.last_verified_at,
            createdAt: this.row.created_at,
            endedAt: this.row.ended_at,
            error: this.row.last_error,
            normalTargetSoc: this.row.baseline?.acTargetRaw
              ? this.row.baseline.acTargetRaw / 10
              : 50,
            proof: this.row.proof,
            approvedAt: this.row.approved_at,
            canApprove:
              sameDevice &&
              !this.active &&
              this.row.test &&
              this.row.state === "restored" &&
              !this.row.approved_at &&
              this.row.binding === binding &&
              this.row.mapping === OUTAGE_MAPPING &&
              outageTestPassed(this.row.proof),
          }
        : null,
    };
  }

  /** @param {object} session @param {object} body @param {string} key @returns {Promise<object>} */
  async prepare(session, body, key) {
    if (session.tenant_id !== this.runtime.tenantId)
      throw new OutageError(
        403,
        "Workspace does not match the signed-in account",
      );
    let target;
    try {
      target = outageTarget(body.targetSoc);
    } catch (error) {
      throw new OutageError(400, error.message);
    }
    const test = body.test === true;
    if (body.test !== undefined && typeof body.test !== "boolean")
      throw new OutageError(400, "Choose a valid outage preparation mode");
    if (test && target < 52)
      throw new OutageError(
        400,
        "Choose a target of at least 52% to verify outage control",
      );
    await this.runtime.initialize();
    await this.load();
    const previous = await this.existing(
      session.id,
      key,
      "outage_prepare",
      target,
      test,
    );
    if (previous) return previous;
    const status = this.status();
    if (test ? !status.canTest : !status.canPrepare) {
      const repeated = await this.existing(
        session.id,
        key,
        "outage_prepare",
        target,
        test,
      );
      if (repeated) return repeated;
      throw new OutageError(
        409,
        test
          ? "Open attended controls before testing outage preparation"
          : "Verified home controls and an approved outage hold test are required",
      );
    }
    if (
      this.runtime.manualTopup ||
      this.runtime.journal.owned ||
      this.runtime.recoveryTesting
    )
      throw new OutageError(
        409,
        "Stop the current app top-up before preparing for an outage",
      );
    const client = await this.pool.connect();
    let job;
    try {
      await client.query("BEGIN");
      const state = (
        await client.query(
          "SELECT control_epoch,control_enabled FROM controller_state WHERE tenant_id=$1 FOR UPDATE",
          [session.tenant_id],
        )
      ).rows[0];
      const duplicate = (
        await client.query(
          "SELECT * FROM command_executions WHERE tenant_id=$1 AND user_id=$2 AND idempotency_key=$3",
          [session.tenant_id, session.id, key],
        )
      ).rows[0];
      if (duplicate) {
        if (
          duplicate.action !== "outage_prepare" ||
          duplicate.detail?.outage?.targetSoc !== target ||
          duplicate.detail?.outage?.test !== test
        )
          throw new OutageError(
            409,
            "The request identifier was already used for another action",
          );
        await client.query("COMMIT");
        return duplicate;
      }
      if (!state?.control_enabled)
        throw new OutageError(409, "Workspace control is not enabled");
      if (
        (
          await client.query(
            "SELECT 1 FROM outage_preparations WHERE tenant_id=$1 AND state=ANY($2::text[])",
            [session.tenant_id, OUTAGE_OPEN_STATES],
          )
        ).rowCount
      )
        throw new OutageError(409, "An outage preparation is already active");
      const epoch = (
        await client.query(
          "UPDATE controller_state SET paused=true,manual_topup=false,topup_expires_at=null,control_epoch=control_epoch+1,updated_at=clock_timestamp() WHERE tenant_id=$1 RETURNING control_epoch",
          [session.tenant_id],
        )
      ).rows[0].control_epoch;
      const id = randomUUID(),
        jobId = randomUUID();
      const detail = { outage: { id, targetSoc: target, test } };
      job = (
        await client.query(
          "INSERT INTO command_executions(tenant_id,id,account_id,device,user_id,actor,action,idempotency_key,status,detail) VALUES($1,$2,$3,$4,$5,$6,'outage_prepare',$7,'queued',$8) RETURNING *",
          [
            session.tenant_id,
            jobId,
            this.runtime.account.id,
            this.runtime.device,
            session.id,
            session.email,
            key,
            detail,
          ],
        )
      ).rows[0];
      await client.query(
        "INSERT INTO outage_preparations(id,tenant_id,account_id,device,binding,mapping,target_soc,state,test,attended_until,command_id,command_epoch) VALUES($1,$2,$3,$4,$5,$6,$7,'queued',$8,$9,$10,$11)",
        [
          id,
          session.tenant_id,
          this.runtime.account.id,
          this.runtime.device,
          commissioningBinding(this.runtime.account, this.runtime.verification),
          OUTAGE_MAPPING,
          target,
          test,
          test ? this.runtime.commissioning.attended_until : null,
          jobId,
          epoch,
        ],
      );
      await client.query(
        "UPDATE command_executions SET status='interrupted',completed_at=clock_timestamp(),message='Cancelled by outage preparation' WHERE tenant_id=$1 AND id<>$2 AND status='queued' AND action IN('topup','resume','enable_controls','commission_topup','commission_recovery','verify')",
        [session.tenant_id, jobId],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    this.runtime.enableEpoch++;
    this.runtime.inhibitStarts = true;
    this.runtime.paused = true;
    this.runtime.manualTopup = false;
    await this.load();
    this.enqueue(job, "apply");
    return job;
  }

  /** @param {object} session @param {string} key @param {string} revision @returns {Promise<object>} */
  async restore(session, key, revision) {
    if (session.tenant_id !== this.runtime.tenantId)
      throw new OutageError(
        403,
        "Workspace does not match the signed-in account",
      );
    await this.load();
    const previous = await this.existing(
      session.id,
      key,
      "outage_restore",
      null,
    );
    if (previous) return previous;
    if (!this.active || String(this.row.revision) !== revision)
      throw new OutageError(
        409,
        "Outage preparation changed; refresh before returning to normal",
      );
    if (!this.status().canRestore)
      throw new OutageError(
        409,
        "Reconnect the original inverter before returning to normal",
      );
    const job = await this.requestRestore(session, key, revision);
    this.runtime.enableEpoch++;
    this.runtime.inhibitStarts = true;
    this.enqueue(job, "restore");
    return job;
  }

  /** @param {object} session @param {string} key @param {string} revision @returns {Promise<object>} */
  async requestRestore(session, key, revision) {
    const client = await this.pool.connect();
    let job;
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT tenant_id FROM controller_state WHERE tenant_id=$1 FOR UPDATE",
        [this.runtime.tenantId],
      );
      if (session && key) {
        const duplicate = (
          await client.query(
            "SELECT * FROM command_executions WHERE tenant_id=$1 AND user_id=$2 AND idempotency_key=$3",
            [this.runtime.tenantId, session.id, key],
          )
        ).rows[0];
        if (duplicate) {
          if (
            duplicate.action !== "outage_restore" ||
            duplicate.detail?.outage?.id !== this.row.id
          )
            throw new OutageError(
              409,
              "The request identifier was already used for another action",
            );
          await client.query("COMMIT");
          return duplicate;
        }
      }
      const state = (
        await client.query(
          "UPDATE controller_state SET paused=true,manual_topup=false,topup_expires_at=null,control_epoch=control_epoch+1,updated_at=clock_timestamp() WHERE tenant_id=$1 RETURNING control_epoch",
          [this.runtime.tenantId],
        )
      ).rows[0];
      const id = randomUUID();
      job = (
        await client.query(
          "INSERT INTO command_executions(tenant_id,id,account_id,device,user_id,actor,action,idempotency_key,status,detail) VALUES($1,$2,$3,$4,$5,$6,'outage_restore',$7,'queued',$8) RETURNING *",
          [
            this.runtime.tenantId,
            id,
            this.row.account_id,
            this.row.device,
            session?.id ?? null,
            session?.email ?? "System recovery",
            key,
            { outage: { id: this.row.id, targetSoc: this.row.target_soc } },
          ],
        )
      ).rows[0];
      const updated = await client.query(
        "UPDATE outage_preparations SET state='restoring',revision=revision+1,command_id=$3,command_epoch=$4,updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2 AND revision=$5 AND state=ANY($6::text[]) RETURNING *",
        [
          this.runtime.tenantId,
          this.row.id,
          id,
          state.control_epoch,
          revision,
          OUTAGE_OPEN_STATES,
        ],
      );
      if (!updated.rowCount)
        throw new OutageError(
          409,
          "Outage preparation changed; refresh before returning to normal",
        );
      await client.query(
        "UPDATE command_executions SET status='interrupted',completed_at=clock_timestamp(),message='Outage request was superseded' WHERE tenant_id=$1 AND id=$2 AND status IN('queued','running')",
        [this.runtime.tenantId, this.row.command_id],
      );
      this.row = updated.rows[0];
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return job;
  }

  /** @param {string} userId @param {string} key @param {string} action @param {number|null} target @returns {Promise<object|null>} */
  async existing(userId, key, action, target, test = false) {
    const row = (
      await this.pool.query(
        "SELECT * FROM command_executions WHERE tenant_id=$1 AND user_id=$2 AND idempotency_key=$3",
        [this.runtime.tenantId, userId, key],
      )
    ).rows[0];
    if (
      row &&
      (row.action !== action ||
        (target !== null &&
          (row.detail?.outage?.targetSoc !== target ||
            row.detail?.outage?.test !== test)))
    )
      throw new OutageError(
        409,
        "The request identifier was already used for another action",
      );
    if (
      !row &&
      (
        await this.pool.query(
          "SELECT 1 FROM command_receipts WHERE tenant_id=$1 AND user_id=$2 AND idempotency_key=$3",
          [this.runtime.tenantId, userId, key],
        )
      ).rowCount
    )
      throw new OutageError(
        409,
        "The original request has expired from history; use a new request identifier",
      );
    return row ?? null;
  }

  /** @param {object} job @param {'apply'|'restore'} phase @returns {void} */
  enqueue(job, phase) {
    if (job.status !== "queued" || this.queued.has(job.id)) return;
    this.queued.add(job.id);
    this.runtime
      .queue(() => this.execute(job, phase), phase === "restore" ? 10 : 5)
      .catch(() => {
        console.error(
          JSON.stringify({ event: "outage_operation_unconfirmed" }),
        );
      })
      .finally(() => this.queued.delete(job.id));
  }

  /** @param {object} job @param {'apply'|'restore'} phase @returns {Promise<void>} */
  async execute(job, phase) {
    const priorExecution = this.runtime.executionId;
    this.runtime.executionId = job.id;
    try {
      await this.load();
      if (!this.active || this.row.command_id !== job.id) {
        await this.finishJob(
          job.id,
          "interrupted",
          "Outage request was superseded",
        );
        return;
      }
      if (this.runtime.stopping || this.runtime.hub.stopping) {
        if (phase === "apply" && !this.row.baseline)
          await this.change({
            state: "failed",
            ended_at: new Date(),
            last_error: "interrupted",
          });
        else
          await this.change({
            state: "recovery-required",
            last_error: "interrupted",
          });
        await this.finishJob(
          job.id,
          "interrupted",
          "Outage request was interrupted; check its current state",
        );
        return;
      }
      await this.pool.query(
        "UPDATE command_executions SET status='running' WHERE tenant_id=$1 AND id=$2",
        [this.runtime.tenantId, job.id],
      );
      this.context = { jobId: job.id, phase };
      if (phase === "restore" && this.row.baseline) {
        this.runtime.firmware = {
          ...providerFirmware(await this.runtime.readProvider("recovery")),
          collectedAt: new Date().toISOString(),
        };
        if (
          !matchingControlFirmware(
            this.row.baseline.firmware,
            this.runtime.firmware,
          )
        )
          throw new OutageError(
            409,
            "Verify the original inverter firmware before restoring outage settings",
          );
      }
      const inspector = new BatteryController(
        {
          command: (command, options) =>
            this.runtime.client.command(command, {
              ...options,
              purpose: phase === "restore" ? "recovery" : "routine",
            }),
        },
        { writesEnabled: false },
      );
      const native = new OutageNativeController(
        inspector,
        (address, values, writePhase) =>
          this.write(address, values, writePhase, inspector),
      );
      if (phase === "apply") {
        await this.authorizeApplication();
        const baseline = {
          ...(await native.baseline()),
          firmware: this.runtime.firmware,
        };
        await this.change({ baseline, state: "applying" });
        await this.authorizeApplication();
        const snapshot = await native.apply(baseline, this.row.target_soc);
        const at = new Date().toISOString();
        const proof = observeOutageHold(
          {
            ...this.row.proof,
            targetSoc: this.row.target_soc,
            appliedAt: at,
            applyWritesVerified: true,
            backupSettingsPreserved: true,
          },
          snapshot,
          Date.now(),
        );
        await this.change({
          state: "active",
          last_verified_at: at,
          proof,
          last_error: null,
        });
        await this.finishJob(
          job.id,
          "succeeded",
          this.row.test
            ? "Supervised outage preparation applied; return to normal before approving the test"
            : "Outage preparation applied; the battery stays reserved until Return to normal",
        );
      } else {
        if (!this.row.baseline) {
          await this.change({
            state: "restored",
            ended_at: new Date(),
            last_error: null,
          });
        } else {
          await native.restore(this.row.baseline, this.row.target_soc);
          const verified = await this.verifiedRestorationWrites();
          const at = new Date().toISOString();
          await this.change({
            state: "restored",
            ended_at: at,
            last_verified_at: at,
            last_error: null,
            proof: {
              ...this.row.proof,
              restoredAt: at,
              restoreWritesVerified: verified,
              backupSettingsPreserved: true,
            },
          });
          await this.pool.query(
            "UPDATE outage_write_intents SET reconciled_at=clock_timestamp() WHERE tenant_id=$1 AND preparation_id=$2 AND status<>'verified' AND reconciled_at IS NULL",
            [this.runtime.tenantId, this.row.id],
          );
        }
        await this.finishJob(
          job.id,
          "succeeded",
          "Normal inverter settings restored and verified; app automation remains paused",
        );
      }
    } catch {
      await this.load();
      const recoverHere =
        phase === "apply" &&
        this.active &&
        this.row.command_id === job.id &&
        this.row.baseline;
      if (this.active && this.row.command_id === job.id) {
        await this.change({
          state: this.row.baseline ? "recovery-required" : "failed",
          ...(this.row.baseline ? {} : { ended_at: new Date() }),
          last_error:
            phase === "apply" ? "apply-unconfirmed" : "restore-unconfirmed",
        });
      }
      await this.finishJob(
        job.id,
        "failed",
        phase === "apply"
          ? "Outage preparation could not be confirmed; review restoration status"
          : "Normal settings are not yet confirmed; restoration remains pending",
      );
      if (recoverHere) {
        this.context = null;
        this.preparedWrite = null;
        const recovery = await this.requestRestore(
          null,
          null,
          String(this.row.revision),
        );
        await this.execute(recovery, "restore");
      }
    } finally {
      this.context = null;
      this.preparedWrite = null;
      this.runtime.executionId = priorExecution;
      this.runtime.reschedulePolling();
    }
  }

  /** @returns {Promise<void>} */
  async authorizeApplication() {
    const r = this.runtime;
    if (
      !r.hostWritesAllowed ||
      !r.ready ||
      r.account?.id !== this.row.account_id ||
      r.device !== this.row.device ||
      r.stopping ||
      r.hub.stopping
    )
      throw new OutageError(
        409,
        "Outage control is unavailable for the current inverter",
      );
    const state = (
      await this.pool.query(
        "SELECT c.*,a.device_sn,a.profile,a.validated_at,a.discovered_devices,t.lifecycle FROM controller_state c JOIN solarman_accounts a ON a.tenant_id=c.tenant_id JOIN tenants t ON t.id=c.tenant_id WHERE c.tenant_id=$1 AND a.id=$2",
        [r.tenantId, this.row.account_id],
      )
    ).rows[0];
    if (
      !state ||
      state.lifecycle !== "active" ||
      !state.control_enabled ||
      !state.paused ||
      state.manual_topup ||
      String(state.control_epoch) !== String(this.row.command_epoch) ||
      !state.validated_at ||
      state.device_sn !== this.row.device ||
      !state.discovered_devices.some(
        (device) => device.deviceSn === this.row.device,
      ) ||
      commissioningBinding(
        { ...state, id: this.row.account_id, timezone: r.timezone },
        state.verification,
      ) !== this.row.binding
    )
      throw new OutageError(409, "Outage control permission changed");
    const run = await currentCommissioning(this.pool, r.tenantId);
    const clock = r.clockEvidence(Date.now());
    if (
      !matchingControlFirmware(state.verification?.firmware, r.firmware) ||
      !clock?.fresh ||
      !clock.passed
    )
      throw new OutageError(
        409,
        "Fresh firmware and inverter-clock verification are required",
      );
    if (this.row.test) {
      if (
        !commissioningAllowed(run, this.row.binding, "attended") ||
        new Date(this.row.attended_until).getTime() <= Date.now()
      )
        throw new OutageError(
          409,
          "The attended outage test session has expired",
        );
    } else {
      if (!commissioningAllowed(run, this.row.binding, "approved"))
        throw new OutageError(409, "Home commissioning approval is required");
      const approval = (
        await this.pool.query(
          "SELECT proof FROM outage_preparations WHERE tenant_id=$1 AND binding=$2 AND mapping=$3 AND test AND state='restored' AND approved_at IS NOT NULL ORDER BY approved_at DESC LIMIT 1",
          [r.tenantId, this.row.binding, OUTAGE_MAPPING],
        )
      ).rows[0];
      if (!approval || !outageTestPassed(approval.proof))
        throw new OutageError(409, "An approved outage hold test is required");
    }
  }

  /** @param {number} address @param {number[]} values @param {'apply'|'restore'} phase @param {object} inspector @returns {Promise<void>} */
  async write(address, values, phase, inspector) {
    await this.load();
    if (
      !this.context ||
      this.row?.command_id !== this.context.jobId ||
      !allowedOutageWrite(
        this.row.baseline,
        this.row.target_soc,
        phase,
        address,
        values,
      )
    )
      throw new OutageError(409, "Outage write is no longer authorized");
    if (phase === "apply") await this.authorizeApplication();
    const at = randomUUID();
    await this.pool.query(
      "INSERT INTO outage_write_intents(id,tenant_id,preparation_id,execution_id,revision,phase,address,register_values) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
      [
        at,
        this.runtime.tenantId,
        this.row.id,
        this.context.jobId,
        this.row.revision,
        phase,
        address,
        JSON.stringify(values),
      ],
    );
    this.preparedWrite = at;
    const writer = new BatteryController(inspector.client, {
      writesEnabled: true,
      writeAudit: {
        prepare: async () => at,
        acknowledge: async () => {
          const result = await this.pool.query(
            "UPDATE outage_write_intents SET status='acknowledged',acknowledged_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2 AND status='prepared'",
            [this.runtime.tenantId, at],
          );
          if (result.rowCount !== 1)
            throw new Error("Outage acknowledgement could not be recorded");
        },
        verify: async () => {
          const result = await this.pool.query(
            "UPDATE outage_write_intents SET status='verified',verified_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2 AND status='acknowledged'",
            [this.runtime.tenantId, at],
          );
          if (result.rowCount !== 1)
            throw new Error("Outage readback could not be recorded");
        },
        uncertain: async () => {
          await this.pool.query(
            "UPDATE outage_write_intents SET status='uncertain' WHERE tenant_id=$1 AND id=$2 AND status<>'verified'",
            [this.runtime.tenantId, at],
          );
        },
      },
    });
    try {
      await writer.writeVerified(
        address,
        values,
        phase === "restore" ? "recovery" : "routine",
      );
    } finally {
      this.preparedWrite = null;
    }
  }

  /** @param {string} command @returns {Promise<void>} */
  async authorizeDispatch(command) {
    const bytes = parseFrame(command);
    if ([3, 4].includes(bytes[1])) return;
    if (
      !this.context ||
      !this.preparedWrite ||
      !this.runtime.hostWritesAllowed ||
      bytes[0] !== 1 ||
      bytes[1] !== 16 ||
      bytes.length < 11 ||
      bytes[6] !== bytes.readUInt16BE(4) * 2 ||
      bytes.length !== bytes[6] + 9
    )
      throw new OutageError(409, "Outage write is no longer authorized");
    const write = (
      await this.pool.query(
        "SELECT w.*,p.state,p.command_id,p.command_epoch,p.baseline,p.target_soc,p.account_id,p.device,p.revision AS current_revision FROM outage_write_intents w JOIN outage_preparations p ON p.tenant_id=w.tenant_id AND p.id=w.preparation_id JOIN controller_state c ON c.tenant_id=p.tenant_id JOIN solarman_accounts a ON a.tenant_id=p.tenant_id AND a.id=p.account_id WHERE w.tenant_id=$1 AND w.id=$2 AND w.status='prepared' AND c.control_epoch=p.command_epoch AND a.device_sn=p.device AND a.profile='bluesun-bse20kh3' AND a.validated_at IS NOT NULL AND p.mapping=$3",
        [this.runtime.tenantId, this.preparedWrite, OUTAGE_MAPPING],
      )
    ).rows[0];
    const values = Array.from({ length: bytes.readUInt16BE(4) }, (_, index) =>
      bytes.readUInt16BE(7 + index * 2),
    );
    if (
      !write ||
      write.account_id !== this.runtime.account?.id ||
      write.device !== this.runtime.device ||
      write.command_id !== this.context.jobId ||
      write.execution_id !== this.context.jobId ||
      String(write.revision) !== String(write.current_revision) ||
      write.address !== bytes.readUInt16BE(2) ||
      !sameWords(values, write.register_values) ||
      write.phase !== this.context.phase ||
      !allowedOutageWrite(
        write.baseline,
        write.target_soc,
        write.phase,
        write.address,
        values,
      ) ||
      (write.phase === "apply"
        ? write.state !== "applying"
        : !["restoring", "recovery-required"].includes(write.state))
    )
      throw new OutageError(409, "Outage write is no longer authorized");
    if (
      !matchingControlFirmware(write.baseline.firmware, this.runtime.firmware)
    )
      throw new OutageError(
        409,
        "Verify the original inverter firmware before restoring outage settings",
      );
    if (write.phase === "apply") await this.authorizeApplication();
  }

  /** @param {object} snapshot @param {number[]} settings @returns {Promise<boolean>} */
  async observe(snapshot, settings) {
    await this.load();
    if (!this.active || this.row.state !== "active" || !this.row.baseline)
      return false;
    if (
      !outageSettingsMatch(
        snapshot,
        settings,
        this.row.baseline,
        this.row.target_soc,
      )
    ) {
      await this.change({ last_error: "settings-changed" });
      return false;
    }
    const at = new Date().toISOString();
    const proof = observeOutageHold(this.row.proof, snapshot, Date.now());
    await this.change({
      proof,
      last_verified_at: at,
      last_error: proof.holdViolatedAt ? "hold-unconfirmed" : null,
    });
    return !proof.holdViolatedAt;
  }

  /** @returns {Promise<boolean>} */
  async recover() {
    await this.load();
    if (
      !this.active ||
      this.row.state === "quarantined" ||
      this.context ||
      this.recoveryQueued
    )
      return false;
    const expired =
      this.row.test &&
      (!this.runtime.commissioningPermitted("attended") ||
        new Date(this.row.attended_until).getTime() <= Date.now());
    const abandoned =
      ["queued", "applying", "restoring"].includes(this.row.state) &&
      !this.queued.has(this.row.command_id);
    if (this.row.state !== "recovery-required" && !expired && !abandoned) {
      if (this.row.state === "active" && !this.queued.has(this.row.command_id))
        await this.finishJob(
          this.row.command_id,
          "interrupted",
          "Outage request was interrupted; check its current state",
        );
      return false;
    }
    if (!this.status().canRestore) return false;
    this.recoveryQueued = true;
    try {
      const job = await this.requestRestore(
        null,
        null,
        String(this.row.revision),
      );
      await this.execute(job, "restore");
      return true;
    } finally {
      this.recoveryQueued = false;
    }
  }

  /** @returns {Promise<boolean>} */
  async stop() {
    await this.load();
    if (!this.active) return false;
    if (!this.status().canRestore)
      throw new OutageError(
        409,
        "Outage restoration needs the original inverter connection",
      );
    const job = await this.requestRestore(
      null,
      null,
      String(this.row.revision),
    );
    await this.execute(job, "restore");
    if (this.active)
      throw new OutageError(
        409,
        "Normal settings are not yet confirmed; restoration remains pending",
      );
    return true;
  }

  /** @param {object} session @param {object} body @returns {Promise<object>} */
  async approve(session, body) {
    if (session.tenant_id !== this.runtime.tenantId)
      throw new OutageError(
        403,
        "Workspace does not match the signed-in account",
      );
    const hash = await this.security.confirmedPassword(
      session.id,
      body.currentPassword,
    );
    if (body.confirmed !== true)
      throw new OutageError(
        400,
        "Confirm that you reviewed the outage test results",
      );
    await this.load();
    if (
      !this.status().preparation?.canApprove ||
      String(this.row.revision) !== body.revision
    )
      throw new OutageError(
        409,
        "A completed verified outage test is required",
      );
    await this.security.withUser(session.id, async (client, user) => {
      await this.security.activeSession(client, session);
      await requireActiveTenant(client, session.tenant_id);
      if (user.tenant_id !== session.tenant_id || user.password_hash !== hash)
        throw new OutageError(
          409,
          "Your session changed; sign in before approving",
        );
      const updated = await client.query(
        "UPDATE outage_preparations SET approved_at=clock_timestamp(),approved_by=$3,revision=revision+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2 AND revision=$4 AND state='restored' AND test AND approved_at IS NULL AND proof=$5::jsonb RETURNING id",
        [
          session.tenant_id,
          this.row.id,
          session.id,
          body.revision,
          JSON.stringify(this.row.proof),
        ],
      );
      if (!updated.rowCount)
        throw new OutageError(
          409,
          "Outage test changed; refresh before approving",
        );
    });
    await this.load();
    return this.status();
  }

  /** @returns {Promise<boolean>} */
  async verifiedRestorationWrites() {
    const rows = (
      await this.pool.query(
        "SELECT phase,address,register_values FROM outage_write_intents WHERE tenant_id=$1 AND preparation_id=$2 AND status='verified'",
        [this.runtime.tenantId, this.row.id],
      )
    ).rows;
    return [
      ["apply", 2500, 3],
      ["apply", 2505, this.row.target_soc * 10],
      ["restore", 2500, 0],
      ["restore", 2505, 500],
    ].every(([phase, address, value]) =>
      rows.some(
        (row) =>
          row.phase === phase &&
          row.address === address &&
          row.register_values[0] === value,
      ),
    );
  }

  /** @param {object} fields @returns {Promise<void>} */
  async change(fields) {
    const allowed = new Set([
      "state",
      "baseline",
      "proof",
      "last_error",
      "last_verified_at",
      "ended_at",
    ]);
    const entries = Object.entries(fields);
    if (!entries.length || entries.some(([key]) => !allowed.has(key)))
      throw new Error("Invalid outage state update");
    const result = await this.pool.query(
      `UPDATE outage_preparations SET ${entries.map(([key], index) => `${key}=$${index + 4}`).join(",")},updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2 AND revision=$3 RETURNING *`,
      [
        this.runtime.tenantId,
        this.row.id,
        this.row.revision,
        ...entries.map(([, value]) => value),
      ],
    );
    if (!result.rowCount)
      throw new OutageError(
        409,
        "Outage preparation changed; refresh its current state",
      );
    this.row = result.rows[0];
  }

  /** @param {string} id @param {string} status @param {string} message @returns {Promise<void>} */
  async finishJob(id, status, message) {
    await this.pool.query(
      "UPDATE command_executions SET status=$3,message=$4,completed_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2 AND status IN('queued','running')",
      [this.runtime.tenantId, id, status, message],
    );
  }
}
