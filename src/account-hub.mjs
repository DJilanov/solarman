import { randomUUID, createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { encryptCredentials, decryptCredentials } from "./credentials.mjs";
import { TenantRuntime } from "./tenant-runtime.mjs";
import { ApiBudget, monitoringInterval } from "./api-budget.mjs";
import { Operations } from "./operations.mjs";
import { DataMaintenance } from "./data-maintenance.mjs";
import { WorkspaceOffboarding } from "./workspace-offboarding.mjs";
import { PolicyObservations } from "./policy-observations.mjs";
import { SecurityError } from "./account-security.mjs";

export class AccountHub {
  constructor(pool, env, key) {
    this.pool = pool;
    this.env = env;
    this.key = key;
    this.runtimes = new Map();
    this.stopping = false;
    this.lock = null;
    this.pacer = Promise.resolve();
    this.lastRequestAt = 0;
    this.work = [];
    this.active = 0;
    this.reloads = new Map();
    this.accountUpdates = new Set();
    this.erasingTenants = new Set();
    this.budget = new ApiBudget(pool, env, (/** @type {string} */ appKey) => {
      for (const runtime of this.runtimes.values())
        if (runtime.appKey === appKey) runtime.reschedulePolling();
    });
    this.operations = new Operations(pool, this);
    this.dataMaintenance = new DataMaintenance(pool);
    this.policyObservations = new PolicyObservations(pool);
    const requireErasureGuard =
      env.NODE_ENV === "production" ||
      env.PUBLIC_URL?.startsWith("https:") === true;
    this.offboarding = new WorkspaceOffboarding(pool, this, {
      guardFile:
        env.ERASURE_GUARD_FILE?.trim() ||
        (requireErasureGuard
          ? "/var/lib/solarman-backup/public/erasure-guard.json"
          : null),
      requireRoot: requireErasureGuard,
    });
  }

  /** @param {TenantRuntime} runtime @returns {number} */
  monitorPollMs(runtime) {
    const allocation = this.budget.capacityFor(
      runtime.appKey,
      runtime.tenantId,
    );
    if (allocation) return allocation.monitorMs;
    const group = [...this.runtimes.values()].filter(
      (candidate) =>
        candidate.appKey === runtime.appKey &&
        candidate.ready &&
        candidate.client &&
        !candidate.stopping,
    );
    if (!group.includes(runtime)) group.push(runtime);
    const scheduled = group.filter((candidate) =>
      candidate.usesScheduledCycle(),
    );
    return monitoringInterval(
      runtime.monitorPollMs,
      group.length - scheduled.length,
      group.reduce(
        (total, candidate) => total + candidate.fixedAnnualCalls(),
        0,
      ),
      this.budget.policy,
    );
  }

  /** @param {TenantRuntime} runtime @returns {Promise<object | null>} */
  async budgetInfo(runtime) {
    if (!runtime.appKey) return null;
    const usage = await this.budget.status(runtime.appKey);
    if (!usage) return null;
    const projected = [...this.runtimes.values()]
      .filter(
        (candidate) =>
          candidate.appKey === runtime.appKey &&
          candidate.ready &&
          candidate.client &&
          !candidate.stopping,
      )
      .reduce((total, candidate) => total + candidate.projectedCalls(), 0);
    return {
      ...usage,
      projected,
      capacity: runtime.capacity(),
    };
  }

  async initialize() {
    this.lock = await this.pool.connect();
    const result = await this.lock.query(
      "SELECT pg_try_advisory_lock(193401,2) AS acquired",
    );
    if (!result.rows[0].acquired) {
      this.lock.release();
      this.lock = null;
      throw new Error("Another scheduler is running");
    }
    this.lock.on("error", () => {
      this.stopping = true;
      for (const runtime of this.runtimes.values()) void runtime.close();
    });
    await this.offboarding.initialize();
    await this.pool.query(
      "UPDATE command_executions SET status='interrupted',message='Service restarted before completion could be confirmed',completed_at=now() WHERE status IN ('queued','running')",
    );
    // The exclusive scheduler rebuilds admissions in creation order, including after a policy reduction.
    await this.pool.query(
      "UPDATE solarman_accounts SET monitoring_admitted=false WHERE monitoring_admitted",
    );
    const tenants = await this.pool.query(
      "SELECT t.id FROM tenants t LEFT JOIN workspace_offboarding o ON o.tenant_id=t.id WHERE t.lifecycle<>'removed' AND o.erasure_started_at IS NULL ORDER BY t.created_at,t.id",
    );
    for (const tenant of tenants.rows) await this.forTenant(tenant.id);
  }

  async reserveRequest() {
    const promise = this.pacer.then(async () => {
      await delay(Math.max(0, 1500 - (Date.now() - this.lastRequestAt)));
      this.lastRequestAt = Date.now();
    });
    this.pacer = promise.then(
      () => undefined,
      () => undefined,
    );
    return promise;
  }

  runLimited(operation, priority = 0) {
    return new Promise((resolve, reject) => {
      this.work.push({ operation, priority, resolve, reject });
      this.work.sort((a, b) => b.priority - a.priority);
      this.drain();
    });
  }

  drain() {
    while (this.active < 2 && this.work.length) {
      const work = this.work.shift();
      this.active++;
      Promise.resolve()
        .then(work.operation)
        .then(work.resolve, work.reject)
        .finally(() => {
          this.active--;
          this.drain();
        });
    }
  }

  async forTenant(tenantId) {
    if (this.erasingTenants.has(tenantId))
      throw new SecurityError(409, "Workspace erasure is in progress");
    if (this.reloads.has(tenantId)) return this.reloads.get(tenantId);
    if (this.runtimes.has(tenantId)) return this.runtimes.get(tenantId);
    const promise = (async () => {
      const allowed = await this.pool.query(
        "SELECT 1 FROM tenants t LEFT JOIN workspace_offboarding o ON o.tenant_id=t.id WHERE t.id=$1 AND t.lifecycle<>'removed' AND o.erasure_started_at IS NULL",
        [tenantId],
      );
      if (!allowed.rowCount)
        throw new SecurityError(409, "Workspace erasure is in progress");
      const account =
        (
          await this.pool.query(
            "SELECT * FROM solarman_accounts WHERE tenant_id=$1",
            [tenantId],
          )
        ).rows[0] ?? null;
      const runtime = new TenantRuntime(this, tenantId, account);
      await runtime.initialize();
      if (this.erasingTenants.has(tenantId)) {
        await runtime.close();
        throw new SecurityError(409, "Workspace erasure is in progress");
      }
      this.runtimes.set(tenantId, runtime);
      runtime.start();
      return runtime;
    })();
    this.reloads.set(tenantId, promise);
    try {
      return await promise;
    } finally {
      this.reloads.delete(tenantId);
    }
  }

  async reload(tenantId) {
    const previous = this.runtimes.get(tenantId);
    if (previous) await previous.close();
    this.runtimes.delete(tenantId);
    const next = await this.forTenant(tenantId);
    if (previous?.appKey && previous.appKey !== next.appKey)
      await this.budget.refreshCapacity(previous.appKey);
    return next;
  }

  /** @param {string} tenantId @param {string|null} appKey @returns {Promise<void>} */
  async lifecycleChanged(tenantId, appKey) {
    const runtime = this.runtimes.get(tenantId);
    if (runtime) {
      const previousLifecycle = runtime.lifecycle;
      runtime.inhibitStarts = true;
      runtime.enableEpoch++;
      await runtime.initialize();
      if (
        previousLifecycle === "offboarding" &&
        runtime.lifecycle !== "offboarding"
      )
        runtime.start();
      if (
        runtime.lifecycle === "offboarding" &&
        runtime.appKey &&
        runtime.account
      )
        await runtime.requestCapacity();
      if (runtime.journal.pending)
        void runtime
          .queue(() => runtime.clearScheduledPermission(), 10)
          .catch(() => {
            console.error(
              JSON.stringify({ event: "workspace_cleanup_pending" }),
            );
          });
      runtime.reschedulePolling();
    }
    for (const key of new Set([appKey, runtime?.appKey].filter(Boolean)))
      await this.budget.refreshCapacity(key);
  }

  async accountInfo(tenantId) {
    const result = await this.pool.query(
      `SELECT id,email,device_sn,profile,station_id,connection_status,connection_message,
      validated_at,discovered_devices,timezone FROM solarman_accounts WHERE tenant_id=$1`,
      [tenantId],
    );
    const readings = await this.pool.query(
      `SELECT r.collected_at,r.data_list FROM provider_readings r
      JOIN solarman_accounts a ON a.id=r.account_id AND a.tenant_id=r.tenant_id
      WHERE r.tenant_id=$1 AND r.device=a.device_sn ORDER BY r.received_at DESC LIMIT 1`,
      [tenantId],
    );
    return {
      account: result.rows[0] ?? null,
      readings: readings.rows[0] ?? null,
      platformApiConfigured: Boolean(
        this.env.SOLARMAN_APP_ID && this.env.SOLARMAN_APP_SECRET,
      ),
    };
  }

  async updateAccount(tenantId, operation) {
    if (this.stopping) throw new Error("The service is stopping");
    if (this.accountUpdates.has(tenantId))
      throw new Error("An account update is already in progress");
    this.accountUpdates.add(tenantId);
    try {
      return await operation();
    } catch (error) {
      try {
        await this.reload(tenantId);
      } catch {
        console.error(JSON.stringify({ event: "account_reload_failed" }));
      }
      throw error;
    } finally {
      this.accountUpdates.delete(tenantId);
    }
  }

  /** @param {TenantRuntime} runtime @returns {Promise<boolean>} */
  async prepareAccountUpdate(runtime) {
    runtime.inhibitStarts = true;
    runtime.enableEpoch++;
    await runtime.journal.requestCleanup({ pause: true, cancelStarts: true });
    await this.pool.query(
      "UPDATE policy_observation_runs SET state='invalidated',reason='connection_changed',ended_at=clock_timestamp() WHERE tenant_id=$1 AND state='observing'",
      [runtime.tenantId],
    );
    runtime.paused = true;
    runtime.manualTopup = false;
    runtime.topupExpiresAt = null;
    try {
      await runtime.queue(() => runtime.clearScheduledPermission(), 10);
    } catch {
      // New credentials may be needed to finish cleanup; its obligation remains in the journal.
    }
    await runtime.close();
    await runtime.journal.load();
    return runtime.journal.owned;
  }

  async connect(tenantId, body) {
    if (
      typeof body.email !== "string" ||
      body.email.length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email.trim()) ||
      typeof body.password !== "string" ||
      body.password.length < 1 ||
      body.password.length > 1024
    ) {
      throw new Error("Enter your SOLARMAN email and password");
    }
    const ownApp = Boolean(body.appId || body.appSecret);
    if (
      ownApp &&
      (typeof body.appId !== "string" ||
        !body.appId.trim() ||
        body.appId.length > 200 ||
        typeof body.appSecret !== "string" ||
        !body.appSecret ||
        body.appSecret.length > 1000)
    )
      throw new Error("Provide both your OpenAPI App ID and App Secret");
    const existing = (
      await this.pool.query(
        "SELECT id,email,credentials FROM solarman_accounts WHERE tenant_id=$1",
        [tenantId],
      )
    ).rows[0];
    if (
      existing &&
      existing.email.toLowerCase() !== body.email.trim().toLowerCase()
    ) {
      throw new Error(
        "This workspace already has a provider account. Update its credentials or create another workspace for a different account.",
      );
    }
    const old = await this.forTenant(tenantId);
    const cleanupUnconfirmed = await this.prepareAccountUpdate(old);
    const id = existing?.id ?? randomUUID();
    const previous =
      existing && !ownApp && body.usePlatform !== true
        ? decryptCredentials(existing.credentials, this.key, tenantId, id)
        : {};
    const retained =
      previous.appId && previous.appSecret && body.usePlatform !== true
        ? { appId: previous.appId, appSecret: previous.appSecret }
        : {};
    const credentials = {
      passwordSha256: createHash("sha256").update(body.password).digest("hex"),
      ...(ownApp
        ? { appId: body.appId.trim(), appSecret: body.appSecret }
        : retained),
    };
    const connection = await this.pool.connect();
    try {
      await connection.query("BEGIN");
      await connection.query(
        `INSERT INTO solarman_accounts (id,tenant_id,email,credentials) VALUES ($1,$2,$3,$4)
      ON CONFLICT (tenant_id) DO UPDATE SET email=EXCLUDED.email,credentials=EXCLUDED.credentials,
      validated_at=null,connection_status='pending',connection_message=null,updated_at=now()`,
        [
          id,
          tenantId,
          body.email.trim().toLowerCase(),
          encryptCredentials(credentials, this.key, tenantId, id),
        ],
      );
      await connection.query(
        "UPDATE controller_state SET paused=true,manual_topup=false,control_enabled=false,verification=null,topup_expires_at=null,updated_at=now() WHERE tenant_id=$1",
        [tenantId],
      );
      if (cleanupUnconfirmed)
        await connection.query(
          "UPDATE solarman_accounts SET connection_message=$2 WHERE tenant_id=$1",
          [
            tenantId,
            "Previous grid-charging permission could not be confirmed off. Test the updated credentials and check device status; automation is paused.",
          ],
        );
      await connection.query("COMMIT");
    } catch (error) {
      await connection.query("ROLLBACK");
      throw error;
    } finally {
      connection.release();
    }
    return this.reload(tenantId);
  }

  async discover(tenantId) {
    const runtime = await this.forTenant(tenantId);
    if (!runtime.client)
      throw new Error(runtime.setupError ?? "OpenAPI credentials are required");
    return runtime.queue(async () => {
      const purpose =
        runtime.journal.owned || runtime.lifecycle === "offboarding"
          ? "recovery"
          : "routine";
      const devices = [];
      try {
        let page = 1;
        let total = Infinity;
        let seen = 0;
        while (seen < total && page <= 20) {
          const result = await runtime.client.api(
            "/station/v1.0/list",
            {
              page,
              size: 50,
            },
            { purpose },
          );
          if (
            !Array.isArray(result.stationList) ||
            !Number.isSafeInteger(Number(result.total))
          )
            throw new Error("Invalid plant-list response");
          total = Number(result.total);
          seen += result.stationList.length;
          for (const station of result.stationList) {
            if (!station || !Number.isSafeInteger(Number(station.id)))
              throw new Error("Invalid plant identifier");
            let devicePage = 1;
            let deviceTotal = Infinity;
            let deviceSeen = 0;
            while (deviceSeen < deviceTotal && devicePage <= 20) {
              const found = await runtime.client.api(
                "/station/v1.0/device",
                {
                  stationId: Number(station.id),
                  deviceType: "INVERTER",
                  page: devicePage,
                  size: 50,
                },
                { purpose },
              );
              if (
                !Array.isArray(found.deviceListItems) ||
                !Number.isSafeInteger(Number(found.total))
              )
                throw new Error("Invalid inverter-list response");
              deviceTotal = Number(found.total);
              deviceSeen += found.deviceListItems.length;
              for (const device of found.deviceListItems) {
                if (
                  device?.deviceType !== "INVERTER" ||
                  typeof device.deviceSn !== "string" ||
                  device.deviceSn.length > 100
                )
                  continue;
                devices.push({
                  deviceSn: device.deviceSn,
                  stationId: Number(station.id),
                  stationName:
                    typeof station.name === "string"
                      ? station.name.slice(0, 200)
                      : "Solar plant",
                });
              }
              if (!found.deviceListItems.length) break;
              devicePage++;
            }
          }
          if (!result.stationList.length) break;
          page++;
        }
        await this.pool.query(
          `UPDATE solarman_accounts SET discovered_devices=$2,connection_status='connected',
          connection_message=null,validated_at=now(),updated_at=now() WHERE tenant_id=$1`,
          [tenantId, JSON.stringify(devices)],
        );
        return devices;
      } catch (error) {
        await this.pool.query(
          "UPDATE solarman_accounts SET connection_status='error',connection_message=$2,validated_at=null WHERE tenant_id=$1",
          [
            tenantId,
            error instanceof Error ? error.message : "Connection test failed",
          ],
        );
        throw error;
      }
    }, 5);
  }

  async bind(tenantId, body) {
    if (
      typeof body.deviceSn !== "string" ||
      !["monitor-only", "bluesun-bse20kh3"].includes(body.profile)
    )
      throw new Error("Choose an inverter and a supported profile");
    const account = (
      await this.pool.query(
        "SELECT * FROM solarman_accounts WHERE tenant_id=$1",
        [tenantId],
      )
    ).rows[0];
    const selected = account?.discovered_devices.find(
      (device) => device.deviceSn === body.deviceSn,
    );
    if (!account?.validated_at || !selected)
      throw new Error(
        "Test your provider connection and choose an inverter returned for your account",
      );
    const timezone =
      typeof body.timezone === "string" ? body.timezone : account.timezone;
    try {
      new Intl.DateTimeFormat("en", { timeZone: timezone }).format();
    } catch {
      throw new Error(
        "Choose a valid IANA timezone matching the inverter clock",
      );
    }
    const old = await this.forTenant(tenantId);
    await this.prepareAccountUpdate(old);
    const unresolved = await this.pool.query(
      "SELECT 1 FROM device_control_state WHERE tenant_id=$1 AND state<>'clear' LIMIT 1",
      [tenantId],
    );
    if (unresolved.rowCount)
      throw new Error(
        "Confirm scheduled charging is off before changing the inverter, profile or timezone",
      );
    const connection = await this.pool.connect();
    try {
      await connection.query("BEGIN");
      await connection.query(
        "UPDATE solarman_accounts SET device_sn=$2,profile=$3,station_id=$4,timezone=$5,updated_at=now() WHERE tenant_id=$1",
        [tenantId, body.deviceSn, body.profile, selected.stationId, timezone],
      );
      await connection.query(
        "UPDATE controller_state SET paused=true,manual_topup=false,control_enabled=false,verification=null,topup_expires_at=null,updated_at=now() WHERE tenant_id=$1",
        [tenantId],
      );
      await connection.query("COMMIT");
    } catch (error) {
      await connection.query("ROLLBACK");
      if (error?.code === "23505")
        throw new Error("This inverter is already linked to another workspace");
      throw error;
    } finally {
      connection.release();
    }
    return this.reload(tenantId);
  }

  async callback(request, response, accountId) {
    const runtime = [...this.runtimes.values()].find(
      (r) => r.account?.id === accountId,
    );
    if (!runtime?.client) {
      response.writeHead(404);
      response.end();
      return;
    }
    await runtime.client.handleHttp(request, response);
  }

  async close() {
    this.stopping = true;
    const monitorStopped = this.operations.stop();
    const maintenanceStopped = this.dataMaintenance.stop();
    const offboardingStopped = this.offboarding.stop();
    const observationsStopped = this.policyObservations.stop();
    await Promise.allSettled(
      [...this.runtimes.values()].map((runtime) => runtime.close()),
    );
    await monitorStopped;
    await maintenanceStopped;
    await offboardingStopped;
    await observationsStopped;
    if (this.lock) {
      try {
        await this.lock.query("SELECT pg_advisory_unlock(193401,2)");
      } catch {
        /* Connection loss releases the lock. */
      }
      this.lock.release();
      this.lock = null;
    }
  }
}
