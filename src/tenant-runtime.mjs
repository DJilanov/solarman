import { randomUUID } from "node:crypto";
import { loadConfig } from "./config.mjs";
import { SolarmanClient } from "./solarman.mjs";
import { BatteryController, decide } from "./controller.mjs";
import { decryptCredentials } from "./credentials.mjs";
import { saveMeasurement } from "./database.mjs";
import { WorkQueue } from "./work-queue.mjs";
import { controlReadiness } from "./control-readiness.mjs";

export class TenantRuntime {
  /** @param {object} hub @param {string} tenantId @param {object | null} account */
  constructor(hub, tenantId, account) {
    this.hub = hub;
    this.pool = hub.pool;
    this.tenantId = tenantId;
    this.account = account;
    this.work = new WorkQueue();
    this.closePromise = null;
    this.stopping = false;
    this.timer = null;
    this.events = [];
    this.lastSuccessAt = null;
    this.lastError = null;
    this.paused = true;
    this.manualTopup = false;
    this.topupExpiresAt = null;
    this.controlEnabled = false;
    this.verification = null;
    this.enableEpoch = 0;
    this.inhibitStarts = false;
    this.pollMs = 900_000;
    this.writesEnabled = false;
    this.hostWritesAllowed = false;
    this.client = null;
    this.setupError = null;
    this.scheduled = new Set();
    this.device = account?.device_sn ?? null;
    this.timezone = account?.timezone ?? "Europe/Sofia";
    this.ready = false;
    this.ratedPowerChecked = false;
    this.profileVerified = false;
    this.profileError = null;
    try {
      if (!account)
        throw new Error("Link your SOLARMAN account to get started");
      const credentials = decryptCredentials(
        account.credentials,
        hub.key,
        tenantId,
        account.id,
      );
      const config = loadConfig(
        {
          ...hub.env,
          SOLARMAN_EMAIL: account.email,
          SOLARMAN_PASSWORD: undefined,
          SOLARMAN_PASSWORD_SHA256: credentials.passwordSha256,
          SOLARMAN_APP_ID: credentials.appId || hub.env.SOLARMAN_APP_ID,
          SOLARMAN_APP_SECRET:
            credentials.appSecret || hub.env.SOLARMAN_APP_SECRET,
          SOLARMAN_DEVICE_SN: account.device_sn || "",
          INVERTER_TIMEZONE: this.timezone,
        },
        { deviceRequired: false },
      );
      this.pollMs = config.pollMs;
      this.hostWritesAllowed = config.writesEnabled;
      this.ready = Boolean(account.validated_at && account.device_sn);
      this.writesEnabled =
        config.writesEnabled &&
        this.ready &&
        account.profile === "bluesun-bse20kh3";
      this.client = new SolarmanClient(config, {
        callbackPrefix: `/solarman/callback/${account.id}/`,
        beforeRequest: () => hub.reserveRequest(),
        onRequest: async (kind) => {
          await this.q(
            "INSERT INTO api_requests (tenant_id,account_id,kind) VALUES ($1,$2,$3)",
            [account.id, kind],
          );
        },
      });
      const log = (event) => this.events.push(event);
      this.controller = new BatteryController(this.client, {
        ...config,
        writesEnabled: false,
        log,
        isStopping: () => this.stopping || hub.stopping || this.inhibitStarts,
      });
      this.inspector = new BatteryController(this.client, {
        ...config,
        writesEnabled: false,
        log,
      });
      if (!account.validated_at)
        this.setupError =
          "Test your linked account connection, then choose an inverter";
      else if (!account.device_sn)
        this.setupError =
          "Choose an inverter from your connected SOLARMAN account";
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      this.setupError = /SOLARMAN_APP_/.test(message)
        ? "OpenAPI app credentials are required for this linked account"
        : /CALLBACK_PUBLIC_URL/.test(message)
          ? "The host needs to configure its secure callback address"
          : message || "Linked account setup is incomplete";
    }
  }

  /** @param {string} sql @param {unknown[]} [values] @returns {Promise<import('pg').QueryResult>} */
  q(sql, values = []) {
    return this.pool.query(sql, [this.tenantId, ...values]);
  }

  async initialize() {
    const result = await this.q(
      "SELECT paused,manual_topup,control_enabled,verification,topup_expires_at FROM controller_state WHERE tenant_id=$1",
    );
    this.paused = result.rows[0].paused;
    this.manualTopup = result.rows[0].manual_topup;
    this.controlEnabled = result.rows[0].control_enabled;
    this.verification = result.rows[0].verification;
    this.topupExpiresAt = result.rows[0].topup_expires_at;
    if (this.controller)
      this.controller.options.writesEnabled =
        this.writesEnabled && this.controlEnabled;
  }

  /** @returns {boolean} */
  verifiedDevice() {
    return Boolean(
      this.verification?.passed &&
        this.verification.device === this.device &&
        this.verification.profile === this.account?.profile,
    );
  }

  /** @returns {ReturnType<typeof controlReadiness>} */
  readiness() {
    const age =
      Date.now() - new Date(this.verification?.checkedAt ?? "").getTime();
    return controlReadiness({
      connected: Boolean(this.client && this.ready),
      supported: this.account?.profile === "bluesun-bse20kh3",
      serverAllowed: this.hostWritesAllowed,
      workspaceEnabled: this.controlEnabled,
      verified:
        this.verifiedDevice() &&
        (this.controlEnabled || (age >= 0 && age <= 1800_000)),
      settingsMatch: this.profileVerified,
      stopping: this.stopping || this.hub.stopping,
    });
  }

  status() {
    const readiness = this.readiness();
    return {
      apiConfigured: Boolean(this.client),
      writesEnabled: readiness.canStart,
      control: {
        serverAllowed: this.hostWritesAllowed,
        workspaceEnabled: this.controlEnabled,
        verification: this.verification,
        ...readiness,
      },
      mode: this.setupError
        ? "setup"
        : this.stopping
          ? "stopping"
          : this.lastError || this.profileError
            ? "error"
            : this.paused && !this.manualTopup
              ? "paused"
              : readiness.canStart
                ? "active"
                : "read-only",
      paused: this.paused,
      manualTopup: this.manualTopup,
      topupExpiresAt: this.topupExpiresAt,
      lastSuccessAt: this.lastSuccessAt,
      error: this.lastError || this.profileError,
      setupError: this.setupError,
      pollSeconds: this.pollMs / 1000,
      annualProjectedCalls: Math.round(
        ((this.account?.profile === "bluesun-bse20kh3" ? 5 : 1) *
          365 *
          86400_000) /
          this.pollMs,
      ),
      profile: this.account?.profile ?? "monitor-only",
      deviceSelected: Boolean(this.device),
      timezone: this.timezone,
      policy: {
        reserveSoc: 50,
        solarTargetSoc: 100,
        acChargeKw: 2,
        solarPowerCapVerified: false,
      },
    };
  }

  queue(operation, priority = 0) {
    if (this.stopping)
      return Promise.reject(new Error("The controller is stopping"));
    return this.work.enqueue(
      () => this.hub.runLimited(operation, priority),
      priority,
    );
  }

  /** @returns {Promise<object>} */
  async verifyDevice() {
    if (
      !this.client ||
      !this.ready ||
      this.account.profile !== "bluesun-bse20kh3"
    )
      throw new Error(
        "Choose a supported inverter before verifying its settings",
      );
    if (!this.paused || this.manualTopup)
      throw new Error(
        "Pause automation before verifying the inverter settings",
      );
    await this.q(
      "UPDATE controller_state SET verification=null,updated_at=now() WHERE tenant_id=$1",
    );
    this.verification = null;
    this.ratedPowerChecked = false;
    const startedAt = Date.now();
    const rated = await this.inspector.read(4, 7, 2);
    const snapshot = await this.inspector.snapshot(false);
    const settings = await this.inspector.settings();
    if (Date.now() - startedAt > 120_000)
      throw new Error("Live readings are too old");
    const checks = [
      {
        label: "Inverter rating",
        actual: rated[0] * 65536 + rated[1],
        expected: 20000,
        unit: "W",
      },
      { label: "Operating mode", actual: snapshot.mode, expected: 0, unit: "" },
      {
        label: "Run and backup flags",
        actual: snapshot.flags & ~16,
        expected: 9,
        unit: "",
      },
      {
        label: "AC charging setting",
        actual: ((rated[0] * 65536 + rated[1]) * snapshot.acPowerRaw) / 1000,
        expected: 2000,
        unit: "W",
      },
      {
        label: "Grid charging SOC target",
        actual: snapshot.acTargetRaw / 10,
        expected: 50,
        unit: "%",
      },
      {
        label: "Overall SOC maximum",
        actual: settings.maximumSoc,
        expected: 100,
        unit: "%",
      },
      {
        label: "On-grid battery reserve",
        actual: settings.reserveSoc,
        expected: 50,
        unit: "%",
      },
    ].map((check) => ({ ...check, passed: check.actual === check.expected }));
    const verification = {
      device: this.device,
      profile: this.account.profile,
      checkedAt: new Date().toISOString(),
      passed: checks.every((check) => check.passed),
      checks,
    };
    await this.q(
      "UPDATE controller_state SET verification=$2,updated_at=now() WHERE tenant_id=$1",
      [JSON.stringify(verification)],
    );
    this.verification = verification;
    this.ratedPowerChecked = checks[0].passed;
    this.profileVerified = checks.slice(1).every((check) => check.passed);
    this.profileError = this.profileVerified
      ? null
      : "Device settings need attention";
    await saveMeasurement(
      this.pool,
      this.tenantId,
      this.account.id,
      this.device,
      snapshot,
    );
    this.lastSuccessAt = verification.checkedAt;
    this.lastError = null;
    return verification;
  }

  start() {
    if (!this.ready || !this.client) return;
    const loop = async () => {
      if (this.stopping || this.hub.stopping) return;
      await this.queue(() => this.evaluate()).catch(() => {});
      if (!this.stopping && !this.hub.stopping)
        this.timer = setTimeout(loop, this.pollMs);
    };
    void loop();
  }

  async collect(inspectOnly = false) {
    if (!this.client || !this.ready)
      throw new Error("Connect your account and choose an inverter first");
    this.events = [];
    if (this.account.profile === "monitor-only") {
      const data = await this.client.api("/device/v1.0/currentData", {
        deviceSn: this.device,
      });
      const collected = Number(data.collectionTime) * 1000;
      if (
        !Array.isArray(data.dataList) ||
        data.dataList.length > 2000 ||
        !Number.isFinite(collected) ||
        collected < Date.now() - 366 * 86400_000 ||
        collected > Date.now() + 30_000
      )
        throw new Error(
          "Provider readings have an invalid format or timestamp",
        );
      const points = data.dataList
        .filter(
          (p) =>
            p &&
            typeof p.key === "string" &&
            ["string", "number"].includes(typeof p.value),
        )
        .map((p) => ({
          key: p.key.slice(0, 200),
          value: String(p.value).slice(0, 1000),
          name: String(p.name ?? p.key).slice(0, 200),
          unit: String(p.unit ?? "").slice(0, 30),
        }));
      await this.q(
        `INSERT INTO provider_readings (tenant_id,account_id,device,collected_at,data_list) VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT (tenant_id,account_id,device) DO UPDATE SET collected_at=EXCLUDED.collected_at,data_list=EXCLUDED.data_list,received_at=now()
        WHERE EXCLUDED.collected_at>=provider_readings.collected_at`,
        [
          this.account.id,
          this.device,
          new Date(collected),
          JSON.stringify(points),
        ],
      );
      this.lastSuccessAt = new Date().toISOString();
      this.lastError = null;
      return { decision: { charge: false, reason: "monitor_only" } };
    }
    const canWrite =
      this.writesEnabled && this.controlEnabled && this.verifiedDevice();
    if (canWrite && !this.ratedPowerChecked) {
      const rated = await this.inspector.read(4, 7, 2);
      if (rated[0] * 65536 + rated[1] !== 20_000)
        throw new Error(
          "The BSE20 charging profile requires verified 20 kW inverter rating",
        );
      this.ratedPowerChecked = true;
    }
    let result;
    if (inspectOnly || !canWrite || (this.paused && !this.manualTopup)) {
      const startedAt = Date.now();
      const snapshot = await this.inspector.snapshot(false);
      const settings = await this.inspector.settings();
      if (Date.now() - startedAt > 120_000)
        throw new Error("Live readings are too old");
      this.profileVerified =
        (snapshot.flags & ~16) === 9 &&
        snapshot.mode === 0 &&
        snapshot.acPowerRaw === 100 &&
        snapshot.acTargetRaw === 500 &&
        settings.maximumSoc === 100 &&
        settings.reserveSoc === 50;
      this.profileError = this.profileVerified
        ? null
        : "Monitoring is available, but inverter settings differ from the supported 2 kW / 50% reserve policy. Hardware controls are blocked.";
      result = {
        snapshot,
        decision: this.profileVerified
          ? decide(snapshot)
          : { charge: false, reason: "monitoring_settings_mismatch" },
      };
    } else {
      result = await this.controller.tick();
      this.profileVerified = true;
      this.profileError = null;
    }
    if (
      !inspectOnly &&
      this.paused &&
      !this.manualTopup &&
      canWrite &&
      this.profileVerified &&
      result.snapshot.flags & 16
    ) {
      await this.controller.disable();
      result.snapshot.flags &= ~16;
    }
    await saveMeasurement(
      this.pool,
      this.tenantId,
      this.account.id,
      this.device,
      result.snapshot,
    );
    this.lastSuccessAt = new Date().toISOString();
    this.lastError = null;
    if (
      !inspectOnly &&
      this.manualTopup &&
      result.decision.reason === "reserve_reached"
    ) {
      await this.q(
        "UPDATE controller_state SET manual_topup=false,topup_expires_at=null,updated_at=now() WHERE tenant_id=$1",
      );
      this.manualTopup = false;
      this.topupExpiresAt = null;
    }
    return result;
  }

  async evaluate() {
    if (this.stopping || this.hub.stopping) return;
    const id = randomUUID();
    try {
      await this.q(
        "INSERT INTO command_executions (tenant_id,id,account_id,actor,action,status) VALUES ($1,$2,$3,'Automation','evaluate','running')",
        [id, this.account.id],
      );
      await this.initialize();
      if (
        this.manualTopup &&
        (!this.topupExpiresAt ||
          new Date(this.topupExpiresAt).getTime() <= Date.now())
      ) {
        await this.q(
          "UPDATE controller_state SET manual_topup=false,topup_expires_at=null,updated_at=now() WHERE tenant_id=$1",
        );
        this.manualTopup = false;
        this.topupExpiresAt = null;
        await this.controller.disable();
        if (this.paused) this.events.push({ event: "manual_topup_expired" });
      }
      const result = await this.collect();
      await this.q(
        "UPDATE command_executions SET status='succeeded',message=$3,detail=$4,completed_at=now() WHERE tenant_id=$1 AND id=$2",
        [
          id,
          reasonLabel(result.decision.reason),
          { decision: result.decision, events: this.events },
        ],
      );
    } catch (error) {
      await this.fail(id, error);
    }
  }

  async fail(id, error, disable = true) {
    this.profileVerified = false;
    this.lastError =
      error instanceof Error ? error.message : "Device request failed";
    if (disable) {
      try {
        await this.controller?.disable();
      } catch {
        this.lastError += "; grid charging off could not be confirmed";
      }
    }
    try {
      await this.q(
        "UPDATE command_executions SET status='failed',message=$3,detail=$4,completed_at=now() WHERE tenant_id=$1 AND id=$2",
        [id, this.lastError, { events: this.events }],
      );
    } catch {
      console.error(JSON.stringify({ event: "command_audit_failed" }));
    }
  }

  async submit(action, user, key) {
    if (user.tenant_id !== this.tenantId)
      throw new Error("Workspace does not match the signed-in account");
    if (this.stopping || this.hub.stopping)
      throw new Error("The controller is stopping");
    if (
      ![
        "refresh",
        "verify",
        "enable_controls",
        "topup",
        "stop",
        "pause",
        "resume",
      ].includes(action)
    )
      throw new Error("Unknown action");
    const requestedEpoch = this.enableEpoch;
    if (["refresh", "topup"].includes(action) && (!this.client || !this.ready))
      throw new Error(
        "Connect your SOLARMAN account and select an inverter first",
      );
    const existing = await this.q(
      "SELECT * FROM command_executions WHERE tenant_id=$1 AND user_id=$2 AND idempotency_key=$3",
      [user.id, key],
    );
    if (existing.rowCount) {
      if (existing.rows[0].action !== action)
        throw new Error(
          "The request identifier was already used for another action",
        );
      return existing.rows[0];
    }
    if (["topup", "resume"].includes(action) && !this.readiness().canStart)
      throw new Error(
        "Hardware writes require an enabled, verified Bluesun profile",
      );
    if (this.scheduled.size >= 5 && !["stop", "pause"].includes(action))
      throw new Error("Wait for a pending command to finish");
    const result = await this.q(
      `INSERT INTO command_executions
      (tenant_id,id,account_id,user_id,actor,action,idempotency_key,status) VALUES ($1,$2,$3,$4,$5,$6,$7,'queued')
      ON CONFLICT (tenant_id,user_id,idempotency_key) DO UPDATE SET idempotency_key=EXCLUDED.idempotency_key RETURNING *`,
      [
        randomUUID(),
        this.account?.id ?? null,
        user.id,
        user.email,
        action,
        key,
      ],
    );
    const job = result.rows[0];
    if (job.action !== action)
      throw new Error(
        "The request identifier was already used for another action",
      );
    if (job.status !== "queued" || this.scheduled.has(job.id)) return job;
    this.scheduled.add(job.id);
    if (["stop", "pause"].includes(action)) {
      this.inhibitStarts = true;
      this.enableEpoch++;
      try {
        await this.q(
          "UPDATE controller_state SET paused=true,manual_topup=false,topup_expires_at=null,updated_at=now() WHERE tenant_id=$1",
        );
      } catch (error) {
        this.scheduled.delete(job.id);
        await this.fail(job.id, error, false);
        throw error;
      }
      this.paused = true;
      this.manualTopup = false;
      this.topupExpiresAt = null;
    }
    const enableEpoch = requestedEpoch;
    this.queue(
      async () => {
        try {
          if (this.stopping || this.hub.stopping) {
            await this.q(
              "UPDATE command_executions SET status='interrupted',message='Controller is stopping',completed_at=now() WHERE tenant_id=$1 AND id=$2",
              [job.id],
            );
            return;
          }
          this.events = [];
          if (
            ["topup", "resume", "enable_controls"].includes(action) &&
            enableEpoch !== this.enableEpoch
          ) {
            await this.q(
              "UPDATE command_executions SET status='interrupted',message='Cancelled by a later stop request',completed_at=now() WHERE tenant_id=$1 AND id=$2",
              [job.id],
            );
            return;
          }
          await this.q(
            "UPDATE command_executions SET status='running' WHERE tenant_id=$1 AND id=$2",
            [job.id],
          );
          let message;
          if (action === "verify") {
            const report = await this.verifyDevice();
            this.events.push({ event: "device_verification", report });
            message = report.passed
              ? "Device settings verified"
              : "Device settings need attention";
          } else if (action === "enable_controls") {
            if (
              !this.readiness().canEnable ||
              Date.now() - new Date(this.verification.checkedAt).getTime() >
                1800_000
            )
              throw new Error(
                "Fresh device verification and administrator permission are required",
              );
            await this.q(
              "UPDATE controller_state SET control_enabled=true,paused=true,manual_topup=false,topup_expires_at=null,updated_at=now() WHERE tenant_id=$1",
            );
            await this.initialize();
            message =
              "Control enabled for this workspace; automation remains paused";
          } else if (["stop", "pause"].includes(action)) {
            await this.q(
              "UPDATE controller_state SET paused=true,manual_topup=false,topup_expires_at=null,updated_at=now() WHERE tenant_id=$1",
            );
            this.paused = true;
            this.manualTopup = false;
            this.topupExpiresAt = null;
            await this.controller?.disable();
            message =
              this.writesEnabled && this.controlEnabled
                ? "Scheduled AC charging permission cleared; automation paused. Native inverter settings still apply."
                : "Automation paused; hardware writes are unavailable in the current setup";
          } else {
            if (["topup", "resume"].includes(action)) {
              if (!this.readiness().canStart)
                throw new Error(
                  "Hardware writes require an enabled, verified Bluesun profile",
                );
              this.inhibitStarts = false;
            }
            if (action === "resume") {
              await this.q(
                "UPDATE controller_state SET paused=false,manual_topup=false,topup_expires_at=null,updated_at=now() WHERE tenant_id=$1",
              );
              this.paused = false;
              this.manualTopup = false;
              this.topupExpiresAt = null;
            }
            if (action === "topup") {
              await this.q(
                "UPDATE controller_state SET manual_topup=true,topup_expires_at=now()+interval '6 hours',updated_at=now() WHERE tenant_id=$1",
              );
              this.manualTopup = true;
              this.topupExpiresAt = new Date(
                Date.now() + 6 * 3600_000,
              ).toISOString();
            }
            if (this.client && this.ready) {
              const result = await this.collect(action === "refresh");
              message = reasonLabel(result.decision.reason);
            } else
              message =
                "Automation will evaluate this workspace after its provider account and device are ready";
          }
          await this.q(
            "UPDATE command_executions SET status='succeeded',message=$3,detail=$4,completed_at=now() WHERE tenant_id=$1 AND id=$2",
            [job.id, message, { events: this.events }],
          );
        } catch (error) {
          if (action === "topup") {
            await this.q(
              "UPDATE controller_state SET manual_topup=false,topup_expires_at=null,updated_at=now() WHERE tenant_id=$1",
            );
            this.manualTopup = false;
          }
          await this.fail(
            job.id,
            error,
            !["refresh", "verify", "enable_controls"].includes(action),
          );
        } finally {
          this.scheduled.delete(job.id);
        }
      },
      action === "stop" || action === "pause" ? 10 : 5,
    ).catch(async () => {
      this.scheduled.delete(job.id);
      await this.fail(
        job.id,
        new Error("The command could not be completed or recorded"),
        false,
      );
    });
    return job;
  }

  close() {
    if (this.closePromise) return this.closePromise;
    this.stopping = true;
    clearTimeout(this.timer);
    this.closePromise = (async () => {
      await this.work.idle();
      try {
        await this.controller?.disable();
      } catch {
        console.error(
          JSON.stringify({ event: "shutdown_grid_disable_unconfirmed" }),
        );
      }
      await this.client?.close();
    })();
    return this.closePromise;
  }
}

export function reasonLabel(reason) {
  return (
    {
      reserve_reached:
        "Battery is at or above the 50% reserve; no scheduled grid top-up is requested",
      below_reserve:
        "Battery is below 50%; grid top-up is eligible when hardware writes are enabled",
      solar_can_charge:
        "Solar surplus can charge the battery without a grid top-up",
      grid_not_available: "Grid voltage is unavailable; the top-up is waiting",
      battery_not_ready: "Battery is not ready for a grid top-up",
      monitor_only: "Read-only device readings updated",
      monitoring_settings_mismatch:
        "Device readings updated; control settings require configuration",
      midnight_boundary:
        "The scheduled top-up is waiting during the inverter midnight boundary",
    }[reason] ?? reason
  );
}
