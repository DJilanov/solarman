import { randomUUID } from "node:crypto";
import { loadConfig } from "./config.mjs";
import { SolarmanClient } from "./solarman.mjs";
import { BatteryController, decide } from "./controller.mjs";
import { decryptCredentials } from "./credentials.mjs";
import { saveMeasurement } from "./database.mjs";
import { WorkQueue } from "./work-queue.mjs";
import { controlReadiness } from "./control-readiness.mjs";
import { apiAppKey, ApiBudgetError } from "./api-budget.mjs";
import {
  BLUESUN_MAPPING,
  TELEMETRY_MAX_AGE_MS,
  parseProviderReading,
  normalizeBluesun,
} from "./telemetry.mjs";

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
    this.controlPollMs = 900_000;
    this.monitorPollMs = 300_000;
    this.telemetry = null;
    this.clock = null;
    this.initialized = false;
    this.cleanupRequired = false;
    this.appKey = null;
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
      this.controlPollMs = config.pollMs;
      this.monitorPollMs = config.telemetryPollMs;
      this.hostWritesAllowed = config.writesEnabled;
      this.ready = Boolean(account.validated_at && account.device_sn);
      this.writesEnabled =
        config.writesEnabled &&
        this.ready &&
        account.profile === "bluesun-bse20kh3";
      this.appKey = apiAppKey(config.appId);
      this.client = new SolarmanClient(config, {
        callbackPrefix: `/solarman/callback/${account.id}/`,
        beforeRequest: () => hub.reserveRequest(),
        onRequest: async (kind, purpose) => {
          await hub.budget.reserve({
            appKey: this.appKey,
            tenantId,
            accountId: account.id,
            kind,
            purpose,
          });
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
    if (!this.initialized) {
      if (this.appKey)
        await this.hub.budget.register(
          this.appKey,
          this.tenantId,
          this.account.id,
        );
      this.profileVerified = this.verifiedDevice();
      this.ratedPowerChecked = this.verifiedDevice();
      this.cleanupRequired = this.controlEnabled;
      this.initialized = true;
    }
    if (this.controller)
      this.controller.options.writesEnabled =
        this.writesEnabled && this.controlEnabled;
  }

  /** @returns {boolean} */
  verifiedDevice() {
    return Boolean(
      this.verification?.passed &&
        this.verification.mapping === BLUESUN_MAPPING &&
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
      cleanupVerified: !this.cleanupRequired,
      clockVerified: Boolean(
        this.clock?.passed &&
          Date.now() - new Date(this.clock.collectedAt).getTime() <=
            TELEMETRY_MAX_AGE_MS,
      ),
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
      telemetry: this.telemetry,
      error: this.lastError || this.profileError,
      setupError: this.setupError,
      pollSeconds: this.pollMs / 1000,
      annualProjectedCalls: Math.round(
        ((this.usesControlCycle() ? 6 : 1) * 365 * 86400_000) / this.pollMs,
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

  /** @returns {boolean} */
  usesControlCycle() {
    return Boolean(
      this.writesEnabled &&
        this.controlEnabled &&
        this.verifiedDevice() &&
        (!this.paused || this.manualTopup),
    );
  }

  get pollMs() {
    return this.usesControlCycle()
      ? this.controlPollMs
      : this.hub.monitorPollMs(this);
  }

  /** @returns {Promise<void>} */
  async clearScheduledPermission() {
    if (!this.writesEnabled || !this.controlEnabled) return;
    this.cleanupRequired = true;
    await this.controller.disable();
    this.cleanupRequired = false;
  }

  /** @param {number} soc @returns {Promise<void>} */
  async finishTopup(soc) {
    if (!this.manualTopup || soc < 50) return;
    await this.q(
      "UPDATE controller_state SET manual_topup=false,topup_expires_at=null,updated_at=now() WHERE tenant_id=$1",
    );
    this.manualTopup = false;
    this.topupExpiresAt = null;
    if (this.paused && this.controlEnabled) {
      this.cleanupRequired = true;
      await this.clearScheduledPermission();
    }
  }

  /** @returns {Promise<import('./telemetry.mjs').ProviderReading>} */
  async readProvider() {
    this.clock = null;
    const data = await this.client.api("/device/v1.0/currentData", {
      deviceSn: this.device,
    });
    const reading = parseProviderReading(data, this.device);
    const receivedAt = new Date().toISOString();
    this.telemetry = {
      source: "provider",
      collectedAt: reading.collectedAt.toISOString(),
      receivedAt,
      deviceState: reading.deviceState,
      clock: null,
    };
    await this.q(
      `INSERT INTO provider_readings (tenant_id,account_id,device,collected_at,data_list) VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (tenant_id,account_id,device) DO UPDATE SET collected_at=EXCLUDED.collected_at,data_list=EXCLUDED.data_list,received_at=now()
      WHERE EXCLUDED.collected_at>=provider_readings.collected_at`,
      [
        this.account.id,
        this.device,
        reading.collectedAt,
        JSON.stringify(reading.points),
      ],
    );
    return reading;
  }

  /** @param {import('./telemetry.mjs').ProviderReading} reading @returns {ReturnType<typeof normalizeBluesun>} */
  mapProvider(reading) {
    this.clock = null;
    const mapped = normalizeBluesun(reading, this.timezone);
    this.clock = {
      ...mapped.clock,
      collectedAt: reading.collectedAt.toISOString(),
    };
    this.telemetry.clock = this.clock;
    return mapped;
  }

  /** @returns {Promise<object>} */
  async collectProvider() {
    const reading = await this.readProvider();
    if (this.account.profile === "monitor-only") {
      this.lastSuccessAt = reading.collectedAt.toISOString();
      this.lastError =
        reading.deviceState === 1 &&
        Date.now() - reading.collectedAt.getTime() <= TELEMETRY_MAX_AGE_MS
          ? null
          : "The inverter is offline or has stale readings";
      return { decision: { charge: false, reason: "monitor_only" } };
    }
    const mapped = this.mapProvider(reading);
    const inserted = await saveMeasurement(
      this.pool,
      this.tenantId,
      this.account.id,
      this.device,
      mapped.snapshot,
      {
        source: "provider",
        observedAt: reading.collectedAt,
        samplingSeconds: this.pollMs / 1000,
      },
    );
    this.lastSuccessAt = reading.collectedAt.toISOString();
    this.lastError = null;
    await this.finishTopup(mapped.snapshot.soc);
    return {
      snapshot: mapped.snapshot,
      decision: {
        charge: false,
        reason: inserted ? "telemetry_updated" : "telemetry_unchanged",
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
    const mapped = this.mapProvider(await this.readProvider());
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
    checks.push({
      label: "Inverter clock difference",
      actual: mapped.clock.skewSeconds,
      expected: 120,
      unit: "s",
      comparison: "at_most",
      passed: mapped.clock.passed,
    });
    const verification = {
      device: this.device,
      profile: this.account.profile,
      mapping: BLUESUN_MAPPING,
      clock: this.clock,
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
      { samplingSeconds: this.pollMs / 1000 },
    );
    this.lastSuccessAt = verification.checkedAt;
    this.telemetry = {
      source: "register",
      collectedAt: verification.checkedAt,
      receivedAt: verification.checkedAt,
      deviceState: 1,
      clock: this.clock,
    };
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
    if (!inspectOnly && this.cleanupRequired)
      await this.clearScheduledPermission();
    if (
      this.account.profile === "monitor-only" ||
      (!inspectOnly && !this.usesControlCycle())
    )
      return this.collectProvider();
    if (!inspectOnly) {
      const mapped = this.mapProvider(await this.readProvider());
      if (!mapped.clock.passed)
        throw new Error("The inverter clock must match the workspace timezone");
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
      await this.clearScheduledPermission();
      result.snapshot.flags &= ~16;
    }
    await saveMeasurement(
      this.pool,
      this.tenantId,
      this.account.id,
      this.device,
      result.snapshot,
      { samplingSeconds: this.pollMs / 1000 },
    );
    this.telemetry = {
      source: "register",
      collectedAt: new Date().toISOString(),
      receivedAt: new Date().toISOString(),
      deviceState: 1,
      clock: this.clock,
    };
    this.lastSuccessAt = new Date().toISOString();
    this.lastError = null;
    if (!inspectOnly) await this.finishTopup(result.snapshot.soc);
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
      if (this.appKey && this.client)
        await this.hub.budget.refreshBalance(this.appKey, this.client);
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
        await this.clearScheduledPermission();
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
    const budgetLimited = error instanceof ApiBudgetError;
    let pauseUnrecorded = false;
    if (budgetLimited && (!this.paused || this.manualTopup)) {
      this.paused = true;
      this.manualTopup = false;
      this.topupExpiresAt = null;
      this.inhibitStarts = true;
      this.enableEpoch++;
      this.cleanupRequired = true;
      try {
        await this.q(
          "UPDATE controller_state SET paused=true,manual_topup=false,topup_expires_at=null,updated_at=now() WHERE tenant_id=$1",
        );
      } catch {
        pauseUnrecorded = true;
      }
    }
    this.profileVerified = false;
    this.lastError =
      error instanceof Error ? error.message : "Device request failed";
    if (pauseUnrecorded)
      this.lastError += "; automation pause could not be recorded";
    if (budgetLimited ? this.cleanupRequired : disable) {
      try {
        await this.clearScheduledPermission();
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
            await this.clearScheduledPermission();
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
            this.cleanupRequired = true;
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
        await this.clearScheduledPermission();
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
      telemetry_updated: "Logger readings updated",
      telemetry_unchanged:
        "Logger data is unchanged; waiting for the next device upload",
      monitoring_settings_mismatch:
        "Device readings updated; control settings require configuration",
      midnight_boundary:
        "The scheduled top-up is waiting during the inverter midnight boundary",
    }[reason] ?? reason
  );
}
