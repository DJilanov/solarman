import { randomUUID } from "node:crypto";
import { loadConfig } from "./config.mjs";
import { SolarmanClient } from "./solarman.mjs";
import { BatteryController, decide } from "./controller.mjs";
import { decryptCredentials } from "./credentials.mjs";
import { saveMeasurement } from "./database.mjs";
import { WorkQueue } from "./work-queue.mjs";
import {
  controlReadiness,
  supportedControlFirmware,
  matchingControlFirmware,
  verificationStatus,
} from "./control-readiness.mjs";
import { apiAppKey, ApiBudgetError, YEAR_MS } from "./api-budget.mjs";
import { ApiCapacityError } from "./api-capacity.mjs";
import { ControlJournal } from "./control-journal.mjs";
import { Supervision } from "./supervision.mjs";
import { DeviceHealth } from "./operations.mjs";
import {
  BLUESUN_MAPPING,
  TELEMETRY_MAX_AGE_MS,
  INVERTER_CLOCK_MAX_SKEW_SECONDS,
  parseProviderReading,
  normalizeBluesun,
  providerFirmware,
} from "./telemetry.mjs";

export class TenantRuntime {
  /** @param {object} hub @param {string} tenantId @param {object | null} account */
  constructor(hub, tenantId, account) {
    this.hub = hub;
    this.pool = hub.pool;
    this.tenantId = tenantId;
    this.account = account;
    this.executionId = null;
    this.journal = new ControlJournal(hub.pool, {
      tenantId,
      accountId: account?.id ?? null,
      device: account?.device_sn ?? null,
    });
    this.health = new DeviceHealth(hub.pool, this.journal.context);
    this.work = new WorkQueue();
    this.closePromise = null;
    this.stopping = false;
    this.timer = null;
    this.nextPollAt = null;
    this.pollCallback = null;
    this.pollRunning = false;
    this.events = [];
    this.lastSuccessAt = null;
    this.lastError = null;
    this.paused = true;
    this.lifecycle = "active";
    this.manualTopup = false;
    this.topupExpiresAt = null;
    this.controlEnabled = false;
    this.verification = null;
    this.enableEpoch = 0;
    this.inhibitStarts = false;
    this.controlPollMs = 900_000;
    this.monitorPollMs = 300_000;
    this.supervision = new Supervision({
      auditMs: 3600_000,
      retryMs: this.controlPollMs,
    });
    this.telemetry = null;
    this.clock = null;
    this.firmware = null;
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
    this.monitoringAdmitted = false;
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
      this.supervision = new Supervision({
        auditMs: config.controlAuditMs,
        retryMs: config.pollMs,
      });
      this.hostWritesAllowed = config.writesEnabled;
      this.ready = Boolean(
        account.validated_at &&
          account.device_sn &&
          account.discovered_devices.some(
            (device) => device.deviceSn === account.device_sn,
          ),
      );
      this.writesEnabled =
        config.writesEnabled &&
        this.ready &&
        account.profile === "bluesun-bse20kh3";
      this.appKey = apiAppKey(config.appId);
      this.client = new SolarmanClient(config, {
        authorizeCommand: (command) => this.journal.authorizeDispatch(command),
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
        writeAudit: {
          prepare: (address, values) =>
            this.journal.prepare(address, values, this.executionId),
          acknowledge: (id) => this.journal.acknowledge(id),
          verify: (id) => this.journal.verify(id),
          uncertain: (id) => this.journal.uncertain(id),
        },
      });
      this.inspector = new BatteryController(
        {
          command: (command, options) =>
            this.client.command(command, {
              ...options,
              purpose:
                this.lifecycle === "offboarding"
                  ? "recovery"
                  : (options?.purpose ?? "routine"),
            }),
        },
        {
          ...config,
          writesEnabled: false,
          log,
        },
      );
      if (!account.validated_at)
        this.setupError =
          "Test your linked account connection, then choose an inverter";
      else if (!account.device_sn)
        this.setupError =
          "Choose an inverter from your connected SOLARMAN account";
      else if (!this.ready)
        this.setupError =
          "The selected inverter was not returned for this provider account";
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
      "SELECT c.paused,c.manual_topup,c.control_enabled,c.verification,c.topup_expires_at,t.lifecycle FROM controller_state c JOIN tenants t ON t.id=c.tenant_id WHERE c.tenant_id=$1",
    );
    this.paused = result.rows[0].paused;
    this.manualTopup = result.rows[0].manual_topup;
    this.controlEnabled = result.rows[0].control_enabled;
    this.verification = result.rows[0].verification;
    this.topupExpiresAt = result.rows[0].topup_expires_at;
    this.lifecycle = result.rows[0].lifecycle;
    if (this.lifecycle !== "active") {
      this.inhibitStarts = true;
      if (
        !this.paused ||
        this.manualTopup ||
        this.controlEnabled ||
        this.verification
      ) {
        await this.journal.requestCleanup({
          pause: true,
          cancelStarts: true,
          revokeControl: true,
        });
        this.paused = true;
        this.manualTopup = false;
        this.topupExpiresAt = null;
        this.controlEnabled = false;
        this.verification = null;
      }
    }
    await this.journal.load(!this.initialized);
    if (!this.initialized) {
      if (this.appKey) await this.requestCapacity();
      this.profileVerified = this.verifiedDevice();
      this.ratedPowerChecked = this.verifiedDevice();
      this.cleanupRequired = this.journal.pending;
      const health = await this.health.initialize();
      if (health?.control_fault) {
        this.profileVerified = false;
        this.profileError =
          "A previous control check failed. Refresh native diagnostics before resuming.";
        this.paused = true;
        this.manualTopup = false;
        this.topupExpiresAt = null;
        this.inhibitStarts = true;
        await this.journal.requestCleanup({ pause: true, cancelStarts: true });
        this.cleanupRequired = this.journal.pending;
      }
      this.initialized = true;
    }
    if (this.paused && !this.manualTopup && this.journal.owned)
      this.cleanupRequired = true;
    if (this.controller)
      this.controller.options.writesEnabled =
        this.writesEnabled && (this.controlEnabled || this.journal.owned);
  }

  /** @returns {boolean} */
  verifiedDevice() {
    return Boolean(
      this.verification?.passed &&
        this.verification.mapping === BLUESUN_MAPPING &&
        supportedControlFirmware(this.verification.firmware) &&
        this.verification.device === this.device &&
        this.verification.profile === this.account?.profile,
    );
  }

  /** @returns {object | null} */
  capacity() {
    return this.appKey && this.ready
      ? this.hub.budget.capacityFor(this.appKey, this.tenantId)
      : null;
  }

  /** @returns {Promise<boolean>} */
  async requestCapacity() {
    const admission = await this.hub.budget.register(
      this.appKey,
      this.tenantId,
      this.account.id,
      { ready: this.ready && this.lifecycle !== "offboarding" },
    );
    this.monitoringAdmitted = admission.admitted;
    if (!admission.admitted || admission.revokeControl) {
      this.paused = true;
      this.manualTopup = false;
      this.topupExpiresAt = null;
      this.inhibitStarts = true;
    }
    if (admission.revokeControl) {
      this.enableEpoch++;
      await this.journal.requestCleanup({
        pause: true,
        cancelStarts: true,
        revokeControl: true,
      });
      this.controlEnabled = false;
      this.verification = null;
      this.cleanupRequired = this.journal.pending;
      await this.hub.budget.refreshCapacity(this.appKey);
    }
    return admission.admitted;
  }

  /** @param {number} [now] @returns {import('./control-readiness.mjs').VerificationStatus} */
  verificationStatus(now = Date.now()) {
    return verificationStatus(this.verification, {
      current: this.verifiedDevice(),
      activated: this.controlEnabled,
      now,
    });
  }

  /** @param {number} [now] @returns {{passed:boolean,skewSeconds:number|null,reportedTime:string|null,collectedAt:string,fresh:boolean,maximumSkewSeconds:number}|null} */
  clockEvidence(now = Date.now()) {
    if (!this.clock) return null;
    const age = now - new Date(this.clock.collectedAt).getTime();
    return {
      ...this.clock,
      fresh: age >= -30_000 && age <= TELEMETRY_MAX_AGE_MS,
      maximumSkewSeconds: INVERTER_CLOCK_MAX_SKEW_SECONDS,
    };
  }

  /** @param {number} [now] @returns {ReturnType<typeof controlReadiness>} */
  readiness(now = Date.now()) {
    const clock = this.clockEvidence(now);
    return controlReadiness({
      tenantActive: this.lifecycle === "active",
      tenantClosing: this.lifecycle === "offboarding",
      connected: Boolean(this.client && this.ready),
      supported: this.account?.profile === "bluesun-bse20kh3",
      serverAllowed: this.hostWritesAllowed,
      workspaceEnabled: this.controlEnabled,
      verified: this.verificationStatus(now).state === "verified",
      firmwareVerified: matchingControlFirmware(
        this.verification?.firmware,
        this.firmware,
      ),
      capacityAvailable: Boolean(this.capacity()?.controlAvailable),
      settingsMatch: this.profileVerified,
      cleanupVerified: !this.cleanupRequired && !this.journal.pending,
      clockVerified: Boolean(clock?.passed),
      clockFresh: Boolean(clock?.fresh),
      stopping: this.stopping || this.hub.stopping,
    });
  }

  status() {
    const now = Date.now();
    const readiness = this.readiness(now);
    return {
      lifecycle: this.lifecycle,
      apiConfigured: Boolean(this.client),
      capacity: this.capacity(),
      nextPollAt:
        this.nextPollAt === null
          ? null
          : new Date(this.nextPollAt).toISOString(),
      writesEnabled: readiness.canStart,
      control: {
        serverAllowed: this.hostWritesAllowed,
        workspaceEnabled: this.controlEnabled,
        verification: this.verification,
        verificationStatus: this.verificationStatus(now),
        clock: this.clockEvidence(now),
        firmware: this.firmware,
        recovery: this.journal.status(this.executionId),
        ...readiness,
      },
      mode:
        this.lifecycle === "offboarding"
          ? "offboarding"
          : this.setupError
            ? "setup"
            : this.stopping
              ? "stopping"
              : this.lastError || this.profileError
                ? "error"
                : this.ready && !this.monitoringAdmitted
                  ? "capacity"
                  : this.paused && !this.manualTopup
                    ? "paused"
                    : this.usesControlCycle()
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
      annualProjectedCalls: this.projectedCalls(),
      supervision: {
        ...this.supervision.status(),
        mode: this.usesControlCycle()
          ? this.usesScheduledCycle()
            ? "scheduled"
            : "native"
          : "monitoring",
      },
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
        this.monitoringAdmitted &&
        this.controlEnabled &&
        this.verifiedDevice() &&
        (!this.paused || this.manualTopup),
    );
  }

  /** @returns {boolean} */
  usesScheduledCycle() {
    return this.usesControlCycle() && this.journal.owned;
  }

  /** @returns {number} */
  fixedAnnualCalls() {
    if (!this.usesControlCycle()) return 0;
    return this.usesScheduledCycle()
      ? (6 * YEAR_MS) / (this.capacity()?.scheduledMs ?? this.controlPollMs)
      : (5 * YEAR_MS) / this.supervision.options.auditMs;
  }

  /** @returns {number} */
  projectedCalls() {
    if (!this.monitoringAdmitted) return 0;
    return Math.round(
      this.fixedAnnualCalls() +
        (this.usesScheduledCycle() ? 0 : YEAR_MS / this.pollMs),
    );
  }

  get pollMs() {
    if (!this.monitoringAdmitted) return this.monitorPollMs;
    if (this.cleanupRequired || this.journal.pending)
      return Math.min(this.monitorPollMs, 300_000);
    return this.usesScheduledCycle()
      ? (this.capacity()?.scheduledMs ?? this.controlPollMs)
      : this.hub.monitorPollMs(this);
  }

  /** @returns {Promise<boolean>} */
  async clearScheduledPermission() {
    await this.journal.requestCleanup({
      pause: this.paused && !this.manualTopup,
    });
    this.cleanupRequired = this.journal.pending;
    if (!this.writesEnabled || (!this.controlEnabled && !this.journal.owned))
      return false;
    this.controller.options.writesEnabled = true;
    const flags = await this.controller.disable();
    if (
      flags === null ||
      flags === undefined ||
      !(await this.journal.confirmOff(flags))
    )
      throw new Error("Scheduled charging off could not be confirmed");
    this.cleanupRequired = false;
    return true;
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
    const data = await this.client.api(
      "/device/v1.0/currentData",
      {
        deviceSn: this.device,
      },
      { purpose: this.lifecycle === "offboarding" ? "recovery" : "routine" },
    );
    const reading = parseProviderReading(data, this.device);
    await this.health.upload(reading);
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

  /** @param {import('./telemetry.mjs').ProviderReading} reading @param {object | null} [verification] @returns {Promise<ReturnType<typeof normalizeBluesun> & {verificationInvalidated: boolean}>} */
  async mapProvider(reading, verification = this.verification) {
    this.clock = null;
    this.firmware = {
      ...providerFirmware(reading),
      collectedAt: reading.collectedAt.toISOString(),
    };
    const currentUpload =
      reading.deviceState === 1 &&
      Date.now() - reading.collectedAt.getTime() <= TELEMETRY_MAX_AGE_MS;
    const modelMatches =
      reading.points.find((point) => point.key === "MMN")?.value.trim() ===
      "BSE20KH3";
    const verificationInvalidated = Boolean(
      currentUpload &&
        (verification?.passed || this.controlEnabled) &&
        (!modelMatches ||
          !matchingControlFirmware(verification?.firmware, this.firmware)),
    );
    if (verificationInvalidated) {
      // Revoke starts atomically without discarding the original device's cleanup obligation.
      this.inhibitStarts = true;
      this.enableEpoch++;
      this.paused = true;
      this.manualTopup = false;
      this.topupExpiresAt = null;
      await this.journal.requestCleanup({
        pause: true,
        cancelStarts: true,
        revokeControl: true,
      });
      this.controlEnabled = false;
      this.verification = null;
      this.profileVerified = false;
      this.ratedPowerChecked = false;
      this.cleanupRequired = this.journal.pending;
      await this.hub.budget.refreshCapacity(this.appKey);
      this.events.push({ event: "firmware_verification_invalidated" });
      if (this.cleanupRequired) await this.clearScheduledPermission();
    }
    const mapped = normalizeBluesun(reading, this.timezone);
    this.clock = {
      ...mapped.clock,
      collectedAt: reading.collectedAt.toISOString(),
    };
    this.telemetry.clock = this.clock;
    return { ...mapped, verificationInvalidated };
  }

  /** @param {import('./telemetry.mjs').ProviderReading | null} [reading] @param {{charge: boolean, reason: string} | null} [decision] @returns {Promise<object>} */
  async collectProvider(reading = null, decision = null) {
    reading ??= await this.readProvider();
    if (this.account.profile === "monitor-only") {
      this.lastSuccessAt = reading.collectedAt.toISOString();
      this.lastError =
        reading.deviceState === 1 &&
        Date.now() - reading.collectedAt.getTime() <= TELEMETRY_MAX_AGE_MS
          ? null
          : "The inverter is offline or has stale readings";
      return { decision: { charge: false, reason: "monitor_only" } };
    }
    const mapped = await this.mapProvider(reading);
    this.supervision.observe(mapped.snapshot, reading.collectedAt);
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
      decision: decision ?? {
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
    return this.health.run(
      () => this.verifyReadings(),
      () => Boolean(this.profileError),
    );
  }

  /** @returns {Promise<object>} */
  async verifyReadings() {
    const previousVerification = this.verification;
    await this.q(
      "UPDATE controller_state SET verification=null,updated_at=now() WHERE tenant_id=$1",
    );
    this.verification = null;
    this.ratedPowerChecked = false;
    const startedAt = Date.now();
    const rated = await this.inspector.read(4, 7, 2);
    const snapshot = await this.inspector.snapshot(false);
    const settings = await this.inspector.settings();
    const mapped = await this.mapProvider(
      await this.readProvider(),
      previousVerification,
    );
    if (Date.now() - startedAt > 120_000)
      throw new Error("Live readings are too old");
    if (await this.journal.confirmOff(snapshot.flags))
      this.cleanupRequired = false;
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
    checks.push({
      label: "Firmware compatibility",
      actual: supportedControlFirmware(mapped.versions) ? 1 : 0,
      expected: 1,
      unit: "",
      passed: supportedControlFirmware(mapped.versions),
    });
    const verification = {
      device: this.device,
      profile: this.account.profile,
      mapping: BLUESUN_MAPPING,
      firmware: mapped.versions,
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
      : !supportedControlFirmware(mapped.versions)
        ? "The firmware is not validated for this control profile"
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
    this.supervision.checked(null);
    return verification;
  }

  start() {
    if (this.lifecycle === "offboarding" && !this.journal.owned) return;
    if (!this.ready || !this.client || this.pollCallback) return;
    const loop = async () => {
      this.timer = null;
      this.nextPollAt = null;
      if (this.stopping || this.hub.stopping) return;
      this.pollRunning = true;
      try {
        await this.queue(() => this.evaluate()).catch(() => {});
      } finally {
        this.pollRunning = false;
      }
      if (!this.stopping && !this.hub.stopping) this.schedulePoll();
    };
    this.pollCallback = loop;
    void loop();
  }

  /** @returns {void} */
  schedulePoll() {
    clearTimeout(this.timer);
    this.timer = null;
    if (this.lifecycle === "offboarding" && !this.journal.owned) {
      this.nextPollAt = null;
      return;
    }
    const delay = this.pollMs;
    this.nextPollAt = Date.now() + delay;
    this.timer = setTimeout(() => {
      void this.pollCallback();
    }, delay);
  }

  /** @returns {void} */
  reschedulePolling() {
    if (!this.pollCallback || this.stopping || this.hub.stopping) return;
    if (this.lifecycle === "offboarding" && !this.journal.owned) {
      clearTimeout(this.timer);
      this.timer = null;
      this.nextPollAt = null;
      return;
    }
    if (!this.timer) {
      if (!this.pollRunning) this.schedulePoll();
      return;
    }
    if (this.nextPollAt !== null && Date.now() + this.pollMs >= this.nextPollAt)
      return;
    clearTimeout(this.timer);
    this.schedulePoll();
  }

  async collect(inspectOnly = false, forceControl = false) {
    if (!this.client || !this.ready)
      throw new Error("Connect your account and choose an inverter first");
    if (!inspectOnly && this.lifecycle === "offboarding") {
      if (this.cleanupRequired || this.journal.pending)
        await this.clearScheduledPermission();
      return { decision: { charge: false, reason: "workspace_offboarding" } };
    }
    if (!inspectOnly && !this.monitoringAdmitted) {
      if (this.cleanupRequired || this.journal.pending)
        await this.clearScheduledPermission();
      if (!(await this.requestCapacity()))
        return {
          decision: { charge: false, reason: "monitoring_capacity_waiting" },
        };
    }
    return this.health.run(
      () => this.collectReadings(inspectOnly, forceControl),
      () => Boolean(this.profileError),
    );
  }

  async collectReadings(inspectOnly = false, forceControl = false) {
    if (!this.executionId) this.events = [];
    if (!inspectOnly && (this.cleanupRequired || this.journal.pending))
      await this.clearScheduledPermission();
    if (
      this.account.profile === "monitor-only" ||
      (!inspectOnly && !this.usesControlCycle())
    )
      return this.collectProvider();
    if (!inspectOnly) {
      const reading = await this.readProvider();
      const mapped = await this.mapProvider(reading);
      if (mapped.verificationInvalidated)
        return this.collectProvider(reading, {
          charge: false,
          reason: "firmware_verification_changed",
        });
      if (!mapped.clock.passed)
        throw new Error("The inverter clock must match the workspace timezone");
      this.supervision.observe(mapped.snapshot, reading.collectedAt);
      this.supervision.options.retryMs =
        this.capacity()?.assessmentMs ?? this.controlPollMs;
      const plan = this.supervision.plan(mapped.snapshot, {
        owned: this.journal.owned,
        verified: this.profileVerified,
        force: forceControl,
      });
      if (!plan.native)
        return this.collectProvider(reading, {
          charge: false,
          reason: plan.reason,
        });
      this.events.push({ event: "native_policy_check", reason: plan.reason });
    } else if (
      !this.clock?.passed ||
      Date.now() - new Date(this.clock.collectedAt).getTime() >
        TELEMETRY_MAX_AGE_MS
    ) {
      await this.mapProvider(await this.readProvider());
    }
    const canWrite =
      this.lifecycle === "active" &&
      this.writesEnabled &&
      this.controlEnabled &&
      this.verifiedDevice();
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
        settings.reserveSoc === 50 &&
        supportedControlFirmware(this.firmware);
      this.profileError = this.profileVerified
        ? null
        : !supportedControlFirmware(this.firmware)
          ? "The firmware is not validated for this control profile"
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
    if (await this.journal.confirmOff(result.snapshot.flags))
      this.cleanupRequired = false;
    this.supervision.checked(result.decision.reason, Date.now(), !inspectOnly);
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
    this.executionId = id;
    this.events = [];
    try {
      await this.q(
        "INSERT INTO command_executions (tenant_id,id,account_id,device,actor,action,status) VALUES ($1,$2,$3,$4,'Automation','evaluate','running')",
        [id, this.account.id, this.device],
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
          {
            decision: result.decision,
            supervision: this.supervision.status(),
            events: this.events,
          },
        ],
      );
    } catch (error) {
      await this.fail(id, error);
    } finally {
      this.executionId = null;
    }
  }

  async fail(id, error, disable = true) {
    const budgetLimited = error instanceof ApiBudgetError;
    let pauseUnrecorded = false;
    const controlFailed = disable && this.writesEnabled && this.controlEnabled;
    if (
      (budgetLimited || controlFailed) &&
      (!this.paused || this.manualTopup)
    ) {
      this.paused = true;
      this.manualTopup = false;
      this.topupExpiresAt = null;
      this.inhibitStarts = true;
      this.enableEpoch++;
      this.cleanupRequired = true;
      try {
        await this.journal.requestCleanup({ pause: true, cancelStarts: true });
      } catch {
        pauseUnrecorded = true;
      }
    }
    if (!(error instanceof ApiCapacityError)) this.profileVerified = false;
    this.lastError =
      error instanceof Error ? error.message : "Device request failed";
    if (controlFailed) this.profileError = this.lastError;
    if (budgetLimited ? this.cleanupRequired : disable) {
      try {
        await this.clearScheduledPermission();
        pauseUnrecorded = false;
      } catch {
        this.lastError +=
          "; scheduled AC permission off could not be confirmed";
      }
    }
    if (pauseUnrecorded)
      this.lastError += "; automation pause could not be recorded";
    if (controlFailed) {
      try {
        await this.health.controlFault(true);
      } catch {
        console.error(JSON.stringify({ event: "device_health_update_failed" }));
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

  /** @param {'enable_controls' | 'resume' | 'topup'} action @param {string} epoch @returns {Promise<boolean>} */
  async applyStartIntent(action, epoch) {
    if (action === "enable_controls") {
      const updated = await this.hub.budget.enableControl({
        appKey: this.appKey,
        tenantId: this.tenantId,
        accountId: this.account.id,
        device: this.device,
        epoch,
      });
      if (updated) await this.initialize();
      return updated;
    }
    // A delayed update must not overwrite a stop committed after this request was accepted.
    const result = await this.q(
      `UPDATE controller_state SET
      paused=CASE WHEN $2='resume' THEN false ELSE paused END,
      manual_topup=($2='topup'),
      topup_expires_at=CASE WHEN $2='topup' THEN now()+interval '6 hours' ELSE null END,
      updated_at=now()
      WHERE tenant_id=$1 AND control_epoch=$3 AND control_enabled AND EXISTS (SELECT 1 FROM tenants t WHERE t.id=$1 AND t.lifecycle='active')
      RETURNING tenant_id`,
      [action, epoch],
    );
    if (!result.rowCount) return false;
    await this.initialize();
    return true;
  }

  /** @param {string} jobId @returns {Promise<void>} */
  async cancelStart(jobId) {
    await this.q(
      "UPDATE command_executions SET status='interrupted',message='Control request cancelled; workspace state changed',detail=$3,completed_at=now() WHERE tenant_id=$1 AND id=$2",
      [jobId, { events: this.events }],
    );
  }

  async submit(action, user, key) {
    if (user.tenant_id !== this.tenantId)
      throw new Error("Workspace does not match the signed-in account");
    if (this.stopping || this.hub.stopping)
      throw new Error("The controller is stopping");
    const tenant = (await this.q("SELECT lifecycle FROM tenants WHERE id=$1"))
      .rows[0];
    this.lifecycle = tenant?.lifecycle ?? "suspended";
    if (
      ["enable_controls", "resume", "topup"].includes(action) &&
      this.lifecycle !== "active"
    )
      throw new Error(
        "This workspace is suspended. New automation and administration are unavailable.",
      );
    if (
      ![
        "refresh",
        "verify",
        "enable_controls",
        "disable_controls",
        "retry_capacity",
        "topup",
        "stop",
        "pause",
        "resume",
      ].includes(action)
    )
      throw new Error("Unknown action");
    const requestedEpoch = this.enableEpoch;
    if (
      ["refresh", "topup", "retry_capacity"].includes(action) &&
      (!this.client || !this.ready)
    )
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
    const receipt = await this.q(
      "SELECT action FROM command_receipts WHERE tenant_id=$1 AND user_id=$2 AND idempotency_key=$3",
      [user.id, key],
    );
    if (receipt.rowCount)
      throw new Error(
        receipt.rows[0].action !== action
          ? "The request identifier was already used for another action"
          : "The original command has expired from history. Use a new request identifier to send another command.",
      );
    if (["topup", "resume"].includes(action) && !this.readiness().canStart)
      throw new Error(
        "Hardware writes require an enabled, verified Bluesun profile",
      );
    if (
      this.scheduled.size >= 5 &&
      !["stop", "pause", "disable_controls"].includes(action)
    )
      throw new Error("Wait for a pending command to finish");
    const controlEpoch = ["enable_controls", "resume", "topup"].includes(action)
      ? (
          await this.q(
            "SELECT control_epoch::text AS epoch FROM controller_state WHERE tenant_id=$1",
          )
        ).rows[0].epoch
      : null;
    const result = await this.q(
      `INSERT INTO command_executions
      (tenant_id,id,account_id,user_id,actor,action,idempotency_key,device,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'queued')
      ON CONFLICT (tenant_id,user_id,idempotency_key) DO UPDATE SET idempotency_key=EXCLUDED.idempotency_key RETURNING *`,
      [
        randomUUID(),
        this.account?.id ?? null,
        user.id,
        user.email,
        action,
        key,
        this.device,
      ],
    );
    const job = result.rows[0];
    if (job.action !== action)
      throw new Error(
        "The request identifier was already used for another action",
      );
    if (job.status !== "queued" || this.scheduled.has(job.id)) return job;
    if (this.stopping || this.hub.stopping) {
      const interrupted = await this.q(
        "UPDATE command_executions SET status='interrupted',message='Controller is stopping',completed_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *",
        [job.id],
      );
      return interrupted.rows[0];
    }
    this.scheduled.add(job.id);
    if (["stop", "pause", "disable_controls"].includes(action)) {
      this.inhibitStarts = true;
      this.enableEpoch++;
      try {
        await this.journal.requestCleanup({
          pause: true,
          cancelStarts: true,
          revokeControl: action === "disable_controls",
        });
      } catch (error) {
        this.scheduled.delete(job.id);
        await this.fail(job.id, error, false);
        throw error;
      }
      this.paused = true;
      this.manualTopup = false;
      this.topupExpiresAt = null;
      if (action === "disable_controls") {
        this.controlEnabled = false;
        this.verification = null;
        try {
          await this.hub.budget.refreshCapacity(this.appKey);
        } catch (error) {
          this.scheduled.delete(job.id);
          await this.fail(job.id, error, false);
          throw error;
        }
      }
    }
    const enableEpoch = requestedEpoch;
    this.queue(
      async () => {
        this.executionId = job.id;
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
          if (action === "retry_capacity") {
            message = (await this.requestCapacity())
              ? "Monitoring capacity is available"
              : "Monitoring is waiting for shared API capacity";
          } else if (action === "verify") {
            const report = await this.verifyDevice();
            this.events.push({ event: "device_verification", report });
            message = report.passed
              ? "Device settings verified"
              : "Device settings need attention";
          } else if (action === "enable_controls") {
            if (!this.capacity()?.controlAvailable)
              throw new ApiCapacityError();
            if (
              !this.readiness().canEnable ||
              Date.now() - new Date(this.verification.checkedAt).getTime() >
                1800_000
            )
              throw new Error(
                "Fresh device verification and administrator permission are required",
              );
            if (
              !(await this.applyStartIntent(action, controlEpoch)) ||
              enableEpoch !== this.enableEpoch
            ) {
              await this.cancelStart(job.id);
              return;
            }
            message =
              "Control enabled for this workspace; automation remains paused";
          } else if (["stop", "pause", "disable_controls"].includes(action)) {
            await this.q(
              "UPDATE controller_state SET paused=true,manual_topup=false,topup_expires_at=null,updated_at=now() WHERE tenant_id=$1",
            );
            this.paused = true;
            this.manualTopup = false;
            this.topupExpiresAt = null;
            const cleared = await this.clearScheduledPermission();
            message = cleared
              ? "Scheduled AC charging permission cleared; automation paused. Native inverter settings still apply."
              : "Automation paused; hardware writes are unavailable in the current setup";
            if (action === "disable_controls")
              message = cleared
                ? "Workspace control disabled; scheduled permission cleared"
                : "Workspace control disabled; scheduled permission off remains unconfirmed";
          } else {
            if (["topup", "resume"].includes(action)) {
              if (!this.readiness().canStart)
                throw new Error(
                  "Hardware writes require an enabled, verified Bluesun profile",
                );
              if (
                !(await this.applyStartIntent(action, controlEpoch)) ||
                enableEpoch !== this.enableEpoch
              ) {
                await this.cancelStart(job.id);
                return;
              }
              this.inhibitStarts = false;
            }
            if (this.client && this.ready) {
              const result = await this.collect(
                action === "refresh",
                ["topup", "resume"].includes(action),
              );
              if (
                ["topup", "resume"].includes(action) &&
                enableEpoch !== this.enableEpoch
              ) {
                await this.cancelStart(job.id);
                return;
              }
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
          this.executionId = null;
          this.scheduled.delete(job.id);
          this.reschedulePolling();
        }
      },
      ["stop", "pause", "disable_controls"].includes(action) ? 10 : 5,
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
        if (this.cleanupRequired || this.journal.owned) {
          const cleared = await this.clearScheduledPermission();
          if (!cleared && this.journal.pending)
            throw new Error("Cleanup pending");
        }
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
      native_charging:
        "The battery is already charging near the 2 kW target; no new scheduled top-up is requested",
      topup_waiting: "Waiting for the next guarded grid top-up assessment",
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
      firmware_verification_changed:
        "Firmware verification changed; automation was paused and workspace control was revoked",
      monitoring_capacity_waiting:
        "Monitoring is waiting for shared API capacity",
      workspace_offboarding:
        "This workspace is closing. New automation is unavailable.",
    }[reason] ?? reason
  );
}
