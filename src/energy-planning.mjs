import { randomUUID, createHash } from "node:crypto";
import { EnergyExperience } from "./energy-experience.mjs";
import { hourlySolarLearning } from "./energy-tools-model.mjs";
import { AccountSecurity, SecurityError } from "./account-security.mjs";
import { requireActiveTenant } from "./tenant-lifecycle.mjs";
import { commissioningBinding } from "./commissioning-state.mjs";
import {
  emptyEnergyProfile,
  ENERGY_MODEL_VERSION,
  validateEnergyProfile,
  missingEnergyInputs,
  energyProfileHash,
  energySiteHash,
} from "./energy-profile.mjs";
import {
  energyWeatherConfig,
  OpenMeteoEnergyForecast,
  EnergyForecastError,
} from "./energy-forecast.mjs";
import {
  calibrateEnergySolar,
  energyMeasuredBuckets,
  learnEnergyDemand,
  predictEnergyDemand,
  estimateBackupEndurance,
  suggestSurplusLoads,
} from "./energy-history.mjs";
import { energyNightWindows } from "./energy-time.mjs";
import {
  calculateEnergyPlan,
  calculateEnergyOutcomes,
} from "./energy-calculation.mjs";
import { scoreEnergyPlan } from "./energy-outcomes.mjs";
import { nightNativeWindows } from "./energy-native.mjs";
import { WorkQueue } from "./work-queue.mjs";

const PENDING = ["scheduled", "starting", "running", "restoring"];
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
/** @param {unknown} value @returns {string} */
function revision(value) {
  if (typeof value !== "string" || !/^\d{1,18}$/.test(value))
    throw new SecurityError(400, "Choose the current energy-settings revision");
  return value;
}
/** @param {object} plan @returns {object} */
function publicPlan(plan) {
  return {
    id: plan.id,
    state: plan.state,
    code: plan.code,
    createdAt: plan.created_at,
    settingsRevision: String(plan.settings_revision),
    startsAt: plan.starts_at,
    endsAt: plan.ends_at,
    prediction: plan.prediction,
    reading: plan.reading,
    demandQuality: plan.demand.quality,
    demandDays: plan.demand.days,
    demandCoveredHours: plan.demand.coveredHours,
    forecast: plan.forecast,
    currency: plan.profile.tariff.currency,
    timezone: plan.profile.timezone,
    approvedTargetSoc: plan.approved_snapshot?.prediction?.targetSoc ?? null,
    assessment: plan.assessment ?? null,
  };
}

export class EnergyPlanning {
  /** @param {import('pg').Pool} pool @param {object} hub @param {object} [options] */
  constructor(pool, hub, options = {}) {
    this.pool = pool;
    this.hub = hub;
    this.security = new AccountSecurity(pool);
    this.weather =
      options.weather ??
      new OpenMeteoEnergyForecast(energyWeatherConfig(hub.env));
    this.pending = new Map();
    this.cursor = null;
    this.hintRequests = new Map();
    this.calculations = new WorkQueue();
    this.abort = new AbortController();
    this.timer = null;
    this.releaseTimer = null;
    this.releaseCycle = null;
    this.releasing = new Map();
    this.cycle = null;
    this.stopping = false;
    this.experience = new EnergyExperience(pool, hub);
  }
  /** @param {string} tenantId @param {string} [timezone] @returns {Promise<object>} */
  async settings(tenantId, timezone = "Europe/Sofia") {
    const row = (
      await this.pool.query(
        "SELECT * FROM energy_settings WHERE tenant_id=$1",
        [tenantId],
      )
    ).rows[0];
    return (
      row ?? {
        tenant_id: tenantId,
        revision: "0",
        profile: emptyEnergyProfile(timezone),
        automatic: false,
        last_code: null,
      }
    );
  }
  /** @param {object} runtime @returns {Promise<object>} */
  async installationHints(runtime) {
    if (!runtime.client || !runtime.account?.station_id)
      throw new SecurityError(
        409,
        "Select a SOLARMAN installation before importing its location",
      );
    const cache = this.hintRequests.get(runtime.tenantId);
    if (
      cache &&
      cache.accountId === runtime.account.id &&
      cache.stationId === runtime.account.station_id &&
      cache.at > Date.now() - 5 * 60000
    ) {
      if (cache.value) return cache.value;
      throw new SecurityError(
        429,
        "Wait five minutes before requesting installation details again",
      );
    }
    this.hintRequests.set(runtime.tenantId, {
      at: Date.now(),
      accountId: runtime.account.id,
      stationId: runtime.account.station_id,
    });
    const account = runtime.account;
    const result = await runtime.queue(async () => {
      for (let page = 1; page <= 5; page++) {
        const data = await runtime.client.api("/station/v1.0/list", {
          page,
          size: 100,
        });
        if (!Array.isArray(data.stationList))
          throw new SecurityError(
            503,
            "SOLARMAN installation details are unavailable",
          );
        const station = data.stationList.find(
          (item) => item && String(item.id) === String(account.station_id),
        );
        if (station) {
          const bounded = (value, min, max) =>
            value !== null &&
            value !== undefined &&
            value !== "" &&
            Number.isFinite(Number(value)) &&
            Number(value) >= min &&
            Number(value) <= max
              ? Number(value)
              : null;
          return {
            latitude: bounded(station.locationLat, -90, 90),
            longitude: bounded(station.locationLng, -180, 180),
            panelKwp: bounded(station.installedCapacity, 0.01, 10000),
            source: "solarman-registered-location",
          };
        }
        if (data.stationList.length < 100) break;
      }
      throw new SecurityError(
        404,
        "The selected SOLARMAN installation was not found",
      );
    });
    if (
      runtime.account.id !== account.id ||
      runtime.account.station_id !== account.station_id
    )
      throw new SecurityError(
        409,
        "The installation changed; refresh before importing",
      );
    this.hintRequests.set(runtime.tenantId, {
      at: Date.now(),
      value: result,
      accountId: account.id,
      stationId: account.station_id,
    });
    return result;
  }
  /** @param {object} runtime @param {number} [days] @returns {Promise<object[]>} */
  async readings(runtime, days = 28) {
    if (!runtime.account || !runtime.device) return [];
    return (
      await this.pool.query(
        "SELECT observed_at,soc,pv_w,load_w,grid_w,battery_w,sampling_seconds FROM measurements WHERE tenant_id=$1 AND account_id=$2 AND device=$3 AND observed_at>=clock_timestamp()-$4*interval '1 day' AND observed_at<=clock_timestamp() ORDER BY observed_at DESC LIMIT 30000",
        [runtime.tenantId, runtime.account.id, runtime.device, days],
      )
    ).rows.reverse();
  }
  /** @param {object} runtime @returns {Promise<object>} */
  async status(runtime) {
    const tenantId = runtime.tenantId,
      settings = await this.settings(tenantId, runtime.timezone);
    const plans = (
      await this.pool.query(
        "SELECT p.*,f.payload AS forecast FROM energy_plans p JOIN energy_forecasts f ON f.tenant_id=p.tenant_id AND f.id=p.forecast_id WHERE p.tenant_id=$1 AND p.account_id=$2 AND p.device=$3 ORDER BY (p.state=ANY($4::text[])) DESC,p.created_at DESC,p.id DESC LIMIT 1",
        [tenantId, runtime.account?.id ?? null, runtime.device ?? "", PENDING],
      )
    ).rows;
    const preview =
      plans[0] && PENDING.includes(plans[0].state)
        ? (
            await this.pool.query(
              "SELECT p.*,f.payload AS forecast FROM energy_plans p JOIN energy_forecasts f ON f.tenant_id=p.tenant_id AND f.id=p.forecast_id WHERE p.tenant_id=$1 AND p.account_id=$2 AND p.device=$3 AND p.state='recommended' AND p.settings_revision=$4 AND p.profile_hash=$5 AND p.starts_at=$6 AND p.binding=$7 AND p.created_at>=$8 AND p.created_at>clock_timestamp()-interval '15 minutes' AND f.expires_at>clock_timestamp() ORDER BY p.created_at DESC,p.id DESC LIMIT 1",
              [
                tenantId,
                runtime.account?.id ?? null,
                runtime.device ?? "",
                settings.revision,
                energyProfileHash(settings.profile),
                plans[0].starts_at,
                plans[0].binding,
                plans[0].created_at,
              ],
            )
          ).rows[0]
        : null;
    const outcomes = (
      await this.pool.query(
        "SELECT day,payload FROM energy_outcomes WHERE tenant_id=$1 AND site_hash=$2 ORDER BY day DESC,(payload->>'forecastAt')::timestamptz DESC LIMIT 60",
        [tenantId, energySiteHash(settings.profile)],
      )
    ).rows;
    const rows = await this.readings(runtime),
      latest = rows.at(-1),
      now = Date.now();
    const previous = (
      await this.pool.query(
        "SELECT * FROM energy_plans WHERE tenant_id=$1 AND account_id=$2 AND device=$3 AND approved_by IS NOT NULL AND ends_at<clock_timestamp() ORDER BY created_at DESC LIMIT 30",
        [tenantId, runtime.account?.id ?? null, runtime.device ?? ""],
      )
    ).rows;
    const measured = previous.length ? energyMeasuredBuckets(rows) : [];
    const history = previous
      .filter((plan) => plan.prediction.horizon.end <= now)
      .slice(0, 14)
      .map((plan) => ({
        ...publicPlan({ ...plan, forecast: undefined }),
        assessment: scoreEnergyPlan(plan, rows, { buckets: measured }),
      }));
    await runtime.outage.load();
    const native = runtime.outage.status();
    const floorRaw = runtime.outage.row?.baseline?.batterySettings?.[1];
    const nativeFloor =
      Number.isFinite(floorRaw) &&
      runtime.outage.row.account_id === runtime.account?.id &&
      runtime.outage.row.device === runtime.device &&
      runtime.outage.row.binding ===
        commissioningBinding(runtime.account, runtime.verification) &&
      now - new Date(runtime.outage.row.last_verified_at).getTime() < 15 * 60000
        ? floorRaw / 10
        : null;
    return {
      revision: String(settings.revision),
      profile: settings.profile,
      automatic: settings.automatic,
      missing: missingEnergyInputs(settings.profile),
      providerAvailable: this.weather.available(tenantId),
      calculating: this.pending.has(tenantId),
      code: settings.last_code,
      attemptedAt: settings.attempted_at ?? null,
      plan: plans[0] ? publicPlan(plans[0]) : null,
      preview: preview ? publicPlan(preview) : null,
      history,
      outcomes: outcomes
        .filter(
          (row, index, list) =>
            list.findIndex((item) => String(item.day) === String(row.day)) ===
            index,
        )
        .slice(0, 14)
        .map((row) => row.payload),
      endurance: estimateBackupEndurance(
        settings.profile,
        latest
          ? { soc: latest.soc, at: new Date(latest.observed_at).toISOString() }
          : null,
        rows,
        now,
        nativeFloor,
      ),
      control: {
        canActivate:
          !runtime.outage.active && native.canPrepare && runtime.controlEnabled,
        supported: native.supported,
        enabled: runtime.controlEnabled,
        holdApproved: native.capabilityApproved,
        active: runtime.outage.active,
        purpose: runtime.outage.row?.purpose ?? null,
        state: runtime.outage.row?.state ?? null,
        targetSoc: runtime.outage.row?.target_soc ?? null,
        endsAt: runtime.outage.row?.ends_at ?? null,
      },
      estimated: true,
    };
  }
  /** @param {object} session @param {string} action @param {object} body @param {string} key @param {object} runtime @returns {Promise<object>} */
  async change(session, action, body, key, runtime) {
    if (typeof key !== "string" || !UUID.test(key))
      throw new SecurityError(400, "A unique request identifier is required");
    if (session.tenant_id !== runtime.tenantId)
      throw new SecurityError(
        403,
        "Workspace does not match the signed-in account",
      );
    if (!["settings", "apply", "pause"].includes(action))
      throw new SecurityError(400, "Choose a valid energy action");
    revision(body.revision);
    const allowed =
      action === "settings"
        ? ["revision", "profile"]
        : action === "apply"
          ? ["revision", "planId", "choice", "currentPassword"]
          : ["revision"];
    if (Object.keys(body).some((key) => !allowed.includes(key)))
      throw new SecurityError(400, "Unknown energy action setting");
    let profile;
    if (action === "settings") {
      try {
        profile = validateEnergyProfile(body.profile);
      } catch (error) {
        throw new SecurityError(400, error.message);
      }
    }
    if (
      action === "apply" &&
      (typeof body.planId !== "string" ||
        !UUID.test(body.planId) ||
        !["tonight", "automatic"].includes(body.choice))
    )
      throw new SecurityError(400, "Choose a current plan and charging mode");
    const fingerprint = JSON.stringify(
      action === "settings"
        ? { revision: body.revision, profile: energyProfileHash(profile) }
        : {
            revision: body.revision,
            planId: body.planId ?? null,
            choice: body.choice ?? null,
          },
    );
    const prior = (
      await this.pool.query(
        "SELECT action,result FROM energy_events WHERE tenant_id=$1 AND user_id=$2 AND idempotency_key=$3",
        [session.tenant_id, session.id, key],
      )
    ).rows[0];
    if (prior) {
      if (prior.action !== action || prior.result.fingerprint !== fingerprint)
        throw new SecurityError(
          409,
          "The request identifier was already used for another action",
        );
      return prior.result.value;
    }
    const hash =
      action === "apply"
        ? await this.security.confirmedPassword(
            session.id,
            body.currentPassword,
          )
        : null;
    const result = await this.security.withUser(
      session.id,
      async (client, user) => {
        await this.security.activeSession(client, session);
        await requireActiveTenant(client, session.tenant_id);
        if (
          user.tenant_id !== session.tenant_id ||
          (hash && hash !== user.password_hash)
        )
          throw new SecurityError(
            409,
            "Your session changed; sign in before saving",
          );
        await client.query(
          "SELECT tenant_id FROM controller_state WHERE tenant_id=$1 FOR UPDATE",
          [session.tenant_id],
        );
        const inserted = await client.query(
          "INSERT INTO energy_settings(tenant_id,profile) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING tenant_id",
          [session.tenant_id, emptyEnergyProfile(runtime.timezone)],
        );
        const settings = (
          await client.query(
            "SELECT * FROM energy_settings WHERE tenant_id=$1 FOR UPDATE",
            [session.tenant_id],
          )
        ).rows[0];
        const duplicate = (
          await client.query(
            "SELECT action,result FROM energy_events WHERE tenant_id=$1 AND user_id=$2 AND idempotency_key=$3",
            [session.tenant_id, session.id, key],
          )
        ).rows[0];
        if (duplicate) {
          if (
            duplicate.action !== action ||
            duplicate.result.fingerprint !== fingerprint
          )
            throw new SecurityError(
              409,
              "The request identifier was already used for another action",
            );
          return duplicate.result.value;
        }
        if (
          String(settings.revision) !== body.revision &&
          !(body.revision === "0" && inserted.rowCount === 1)
        )
          throw new SecurityError(
            409,
            "Energy settings changed; refresh before saving",
          );
        const active = (
          await client.query(
            "SELECT id,purpose FROM outage_preparations WHERE tenant_id=$1 AND state IN('queued','applying','active','restoring','recovery-required','quarantined')",
            [session.tenant_id],
          )
        ).rows[0];
        if (action === "settings") {
          if (active?.purpose === "night")
            throw new SecurityError(
              409,
              "Stop night savings before changing its installation settings",
            );
          await client.query(
            "UPDATE energy_settings SET profile=$2,automatic=false,approval_binding=null,approved_by=null,revision=revision+1,last_code=null,updated_at=clock_timestamp() WHERE tenant_id=$1",
            [session.tenant_id, profile],
          );
          await client.query(
            "UPDATE energy_plans SET state='cancelled',code='settings-changed',updated_at=clock_timestamp() WHERE tenant_id=$1 AND state IN('recommended','scheduled')",
            [session.tenant_id],
          );
        } else if (action === "pause") {
          await client.query(
            "UPDATE energy_settings SET automatic=false,approval_binding=null,approved_by=null,revision=revision+1,updated_at=clock_timestamp() WHERE tenant_id=$1",
            [session.tenant_id],
          );
          await client.query(
            "UPDATE energy_plans SET state='cancelled',code='paused',updated_at=clock_timestamp() WHERE tenant_id=$1 AND state IN('scheduled','recommended')",
            [session.tenant_id],
          );
        } else {
          await runtime.outage.load();
          if (
            active ||
            !runtime.outage.status().canPrepare ||
            !runtime.controlEnabled
          )
            throw new SecurityError(
              409,
              "Verified home controls and an approved outage hold test are required",
            );
          const plan = (
            await client.query(
              "SELECT p.*,f.expires_at FROM energy_plans p JOIN energy_forecasts f ON f.tenant_id=p.tenant_id AND f.id=p.forecast_id WHERE p.tenant_id=$1 AND p.id=$2 FOR UPDATE OF p",
              [session.tenant_id, body.planId],
            )
          ).rows[0];
          const binding = commissioningBinding(
            runtime.account,
            runtime.verification,
          );
          if (
            !plan ||
            plan.state !== "recommended" ||
            plan.profile_hash !== energyProfileHash(settings.profile) ||
            String(plan.settings_revision) !== String(settings.revision) ||
            plan.account_id !== runtime.account?.id ||
            plan.device !== runtime.device ||
            plan.prediction.version !== ENERGY_MODEL_VERSION ||
            plan.binding !== binding ||
            !binding
          )
            throw new SecurityError(
              409,
              "Choose a current plan for the selected inverter",
            );
          if (plan.prediction.action === "normal" && body.choice === "tonight")
            throw new SecurityError(
              409,
              "This recommendation does not need grid charging",
            );
          if (
            Date.now() - new Date(plan.created_at).getTime() > 15 * 60000 ||
            new Date(plan.expires_at).getTime() <= Date.now() ||
            plan.prediction.night.releaseAt <= Date.now() + 10 * 60000
          )
            throw new SecurityError(
              409,
              "Refresh the forecast and recommendation before activating",
            );
          if (
            settings.profile.battery.reserveSoc !== 50 ||
            settings.profile.battery.gridChargeKw !== 2 ||
            settings.profile.timezone !== runtime.timezone
          )
            throw new SecurityError(
              409,
              "The supported control profile requires a 50% reserve, 2 kW grid charging and the inverter timezone",
            );
          await this.admitNight(client, session.tenant_id, plan.ends_at);
          await client.query(
            "UPDATE energy_plans SET state='cancelled',code='superseded',updated_at=clock_timestamp() WHERE tenant_id=$1 AND state='scheduled'",
            [session.tenant_id],
          );
          await client.query(
            "UPDATE energy_plans SET state='scheduled',approved_by=$3,approved_snapshot=jsonb_build_object('profile',profile,'demand',demand,'reading',reading,'forecastId',forecast_id,'prediction',prediction),updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2",
            [session.tenant_id, plan.id, session.id],
          );
          await client.query(
            "UPDATE energy_settings SET automatic=$2,approval_binding=$3,approved_by=$4,updated_at=clock_timestamp() WHERE tenant_id=$1",
            [
              session.tenant_id,
              body.choice === "automatic",
              binding,
              session.id,
            ],
          );
        }
        const value = { accepted: true, action };
        await client.query(
          "INSERT INTO energy_events(id,tenant_id,user_id,idempotency_key,action,result) VALUES($1,$2,$3,$4,$5,$6)",
          [
            randomUUID(),
            session.tenant_id,
            session.id,
            key,
            action,
            { fingerprint, value },
          ],
        );
        return value;
      },
    );
    if (action === "pause")
      void this.release(runtime).catch(() => {
        console.error(JSON.stringify({ event: "night_release_pending" }));
      });
    return result;
  }
  /** @param {object} runtime @param {string} expectedRevision @returns {Promise<object>} */
  async refresh(runtime, expectedRevision) {
    revision(expectedRevision);
    if (this.stopping)
      throw new SecurityError(503, "Energy planning is stopping");
    const settings = await this.settings(runtime.tenantId);
    if (String(settings.revision) !== expectedRevision)
      throw new SecurityError(
        409,
        "Energy settings changed; refresh before calculating",
      );
    if (missingEnergyInputs(settings.profile).length)
      throw new SecurityError(
        400,
        "Complete the installation and tariff settings before planning",
      );
    if (!this.weather.available(runtime.tenantId))
      throw new SecurityError(
        409,
        "Weather forecast access is not configured for this workspace",
      );
    if (this.pending.has(runtime.tenantId)) return { accepted: true };
    if (this.pending.size >= 50)
      throw new SecurityError(429, "Energy planning is busy; try again later");
    const admitted = await this.pool.query(
      "UPDATE energy_settings SET attempted_at=clock_timestamp(),last_code='calculating' WHERE tenant_id=$1 AND revision=$2 AND (attempted_at IS NULL OR attempted_at<clock_timestamp()-interval '5 minutes') RETURNING tenant_id",
      [runtime.tenantId, expectedRevision],
    );
    if (!admitted.rowCount)
      throw new SecurityError(
        429,
        "Wait five minutes before recalculating the forecast",
      );
    const pending = this.calculations.enqueue(() =>
      this.compute(runtime, settings),
    );
    this.pending.set(runtime.tenantId, pending);
    void pending
      .catch(() => {
        console.error(
          JSON.stringify({ event: "energy_calculation_unavailable" }),
        );
      })
      .finally(() => this.pending.delete(runtime.tenantId));
    return { accepted: true };
  }
  /** @param {object} runtime @param {object} body @returns {Promise<object>} */
  async adjust(runtime, body) {
    revision(body.revision);
    if (
      Object.keys(body).some(
        (key) => !["revision", "planId", "targetSoc"].includes(key),
      ) ||
      typeof body.planId !== "string" ||
      !UUID.test(body.planId) ||
      !Number.isInteger(body.targetSoc)
    )
      throw new SecurityError(400, "Choose a valid plan and battery target");
    const settings = await this.settings(runtime.tenantId);
    if (
      String(settings.revision) !== body.revision ||
      body.targetSoc < settings.profile.battery.reserveSoc ||
      body.targetSoc > settings.profile.planning.maximumSoc
    )
      throw new SecurityError(
        409,
        "Choose a target within the current energy settings",
      );
    const plan = (
      await this.pool.query(
        "SELECT id FROM energy_plans WHERE tenant_id=$1 AND id=$2 AND settings_revision=$3 AND state='recommended'",
        [runtime.tenantId, body.planId, settings.revision],
      )
    ).rows[0];
    if (!plan)
      throw new SecurityError(
        409,
        "Choose a current recommendation before adjusting",
      );
    if (this.pending.has(runtime.tenantId) || this.pending.size >= 50)
      throw new SecurityError(429, "Energy planning is busy; try again later");
    const pending = this.calculations.enqueue(() =>
      this.compute(runtime, settings, { targetSoc: body.targetSoc }),
    );
    this.pending.set(runtime.tenantId, pending);
    void pending
      .catch(() => {
        console.error(
          JSON.stringify({ event: "energy_adjustment_unavailable" }),
        );
      })
      .finally(() => this.pending.delete(runtime.tenantId));
    return { accepted: true };
  }
  /** @param {object} runtime @param {object} settings @returns {Promise<object|null>} */
  async compute(runtime, settings, options = {}) {
    const tenantId = runtime.tenantId,
      siteHash = energySiteHash(settings.profile);
    try {
      if (
        this.stopping ||
        runtime.stopping ||
        !runtime.account ||
        !runtime.device
      )
        throw new Error("device-unavailable");
      const rows = await this.readings(runtime),
        now = Date.now(),
        latest = rows.at(-1);
      if (!latest || now - new Date(latest.observed_at).getTime() > 15 * 60000)
        throw new Error("readings-stale");
      await this.assess(runtime, settings.profile, rows);
      const outcomes = (
        await this.pool.query(
          "SELECT payload FROM energy_outcomes WHERE tenant_id=$1 AND site_hash=$2 ORDER BY day LIMIT 90",
          [tenantId, siteHash],
        )
      ).rows.map((row) => row.payload);
      const calibration = calibrateEnergySolar(
        outcomes,
        settings.profile.planning.solarMargin,
        now,
      );
      const frozen = (await this.pool.query(
        "SELECT payload,fetched_at FROM energy_forecasts WHERE tenant_id=$1 AND site_hash=$2 AND fetched_at>clock_timestamp()-interval '30 days' ORDER BY fetched_at DESC LIMIT 120",
        [tenantId, siteHash],
      )).rows;
      const hourly = hourlySolarLearning(frozen, rows, settings.profile.timezone, now);
      if (hourly.some(hour => hour.days >= 7)) {
        calibration.hourly = hourly.map(hour => hour.days >= 7 ? Math.max(0.5, Math.min(1.5, hour.rawScale / calibration.scale)) : 1);
        calibration.version = createHash("sha256").update(JSON.stringify({ base: calibration.version, hourly: calibration.hourly })).digest("hex");
      }
      let forecast = (
        await this.pool.query(
          "SELECT * FROM energy_forecasts WHERE tenant_id=$1 AND site_hash=$2 AND expires_at>clock_timestamp() AND payload->'calibration'->>'version'=$3 ORDER BY fetched_at DESC LIMIT 1",
          [tenantId, siteHash, calibration.version],
        )
      ).rows[0];
      if (!forecast) {
        const payload = await this.weather.fetch(
          settings.profile,
          tenantId,
          calibration,
          this.abort.signal,
        );
        payload.calibration = calibration;
        forecast = {
          id: randomUUID(),
          tenant_id: tenantId,
          site_hash: siteHash,
          payload,
          fetched_at: payload.fetchedAt,
          expires_at: payload.expiresAt,
        };
        await this.pool.query(
          "INSERT INTO energy_forecasts(id,tenant_id,site_hash,fetched_at,expires_at,payload) VALUES($1,$2,$3,$4,$5,$6)",
          [
            forecast.id,
            tenantId,
            siteHash,
            forecast.fetched_at,
            forecast.expires_at,
            forecast.payload,
          ],
        );
      }
      const model = learnEnergyDemand(
        rows,
        settings.profile,
        now,
        forecast.payload.slots,
      );
      if (!model.ready) throw new Error("demand-history-missing");
      const windows = energyNightWindows(settings.profile, now),
        to = windows[1]?.start;
      if (!to) throw new Error("forecast-horizon-missing");
      const demand = predictEnergyDemand(
        model,
        settings.profile,
        forecast.payload.slots,
        now,
        to,
      );
      const prediction = await calculateEnergyPlan(
        {
          profile: settings.profile,
          solar: forecast.payload.slots,
          demand,
          soc: latest.soc,
          initialDischarging: latest.battery_w >= 250,
          now,
          targetOverride: options.targetSoc ?? null,
        },
        this.abort.signal,
      );
      prediction.flexibleLoads = suggestSurplusLoads(
        prediction.selected.timeline,
        settings.profile.loads,
      );
      const id = randomUUID(),
        reading = {
          soc: latest.soc,
          at: new Date(latest.observed_at).toISOString(),
        };
      const saved = await this.pool.query(
        "INSERT INTO energy_plans(id,tenant_id,account_id,device,binding,forecast_id,settings_revision,profile_hash,profile,demand,reading,prediction,state,starts_at,ends_at) SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'recommended',$13,$14 FROM energy_settings s JOIN tenants t ON t.id=s.tenant_id JOIN solarman_accounts a ON a.tenant_id=t.id WHERE s.tenant_id=$2 AND s.revision=$7 AND t.lifecycle='active' AND a.id=$3 AND a.device_sn=$4 RETURNING *",
        [
          id,
          tenantId,
          runtime.account.id,
          runtime.device,
          commissioningBinding(runtime.account, runtime.verification),
          forecast.id,
          settings.revision,
          energyProfileHash(settings.profile),
          settings.profile,
          model,
          reading,
          prediction,
          new Date(prediction.night.start),
          new Date(prediction.night.releaseAt),
        ],
      );
      await this.pool.query(
        "UPDATE energy_settings SET last_code='ready' WHERE tenant_id=$1 AND revision=$2",
        [tenantId, settings.revision],
      );
      return saved.rows[0] ?? null;
    } catch (error) {
      const code =
        error.message ===
        "The selected target cannot be reached in the remaining cheap period"
          ? "target-unreachable"
          : error instanceof EnergyForecastError
            ? error.code
            : [
                  "readings-stale",
                  "demand-history-missing",
                  "device-unavailable",
                ].includes(error.message)
              ? error.message
              : "calculation-unavailable";
      await this.pool.query(
        "UPDATE energy_settings SET last_code=$3 WHERE tenant_id=$1 AND revision=$2",
        [tenantId, settings.revision, code],
      );
      return null;
    }
  }
  /** @param {object} runtime @param {object} profile @param {object[]} rows @returns {Promise<void>} */
  async assess(runtime, profile, rows) {
    const siteHash = energySiteHash(profile),
      forecasts = (
        await this.pool.query(
          "SELECT * FROM energy_forecasts WHERE tenant_id=$1 AND site_hash=$2 AND fetched_at>clock_timestamp()-interval '30 days' ORDER BY fetched_at DESC LIMIT 240",
          [runtime.tenantId, siteHash],
        )
      ).rows;
    if (!forecasts.length) return;
    const results = await calculateEnergyOutcomes(
      { forecasts, rows, profile, now: Date.now() },
      this.abort.signal,
    );
    for (const { forecastId, outcome } of results)
      await this.pool.query(
        "INSERT INTO energy_outcomes(tenant_id,forecast_id,day,site_hash,payload) VALUES($1,$2,$3,$4,$5) ON CONFLICT(tenant_id,forecast_id,day) DO UPDATE SET payload=EXCLUDED.payload,assessed_at=clock_timestamp()",
        [runtime.tenantId, forecastId, outcome.day, siteHash, outcome],
      );
  }
  /** @param {import('pg').PoolClient} client @param {string} tenantId @param {Date|string} endsAt @returns {Promise<void>} */
  async admitNight(client, tenantId, endsAt) {
    await client.query("SELECT pg_advisory_xact_lock(193401,24)");
    const count = (
      await client.query(
        "SELECT count(*)::int AS n FROM energy_plans WHERE tenant_id<>$1 AND state=ANY($2::text[]) AND ends_at BETWEEN $3::timestamptz-interval '3 minutes' AND $3::timestamptz+interval '3 minutes'",
        [tenantId, PENDING, endsAt],
      )
    ).rows[0].n;
    // Bound simultaneous restoration deadlines on the shared command queue.
    if (count >= 3)
      throw new SecurityError(
        409,
        "Shared command capacity cannot accept another night plan ending at this time",
      );
  }

  /** @param {object} preparation @returns {Promise<void>} */
  async authorizeNative(preparation) {
    const row = (
      await this.pool.query(
        "SELECT p.*,s.revision AS current_revision,s.profile AS current_profile,s.approval_binding,s.approved_by AS policy_owner,f.expires_at,t.lifecycle FROM energy_plans p JOIN energy_settings s ON s.tenant_id=p.tenant_id JOIN energy_forecasts f ON f.tenant_id=p.tenant_id AND f.id=p.forecast_id JOIN tenants t ON t.id=p.tenant_id WHERE p.tenant_id=$1 AND p.id=$2",
        [preparation.tenant_id, preparation.energy_plan_id],
      )
    ).rows[0];
    if (
      !row ||
      row.lifecycle !== "active" ||
      !["starting", "running"].includes(row.state) ||
      !row.approved_by ||
      row.binding !== preparation.binding ||
      row.approval_binding !== row.binding ||
      String(row.settings_revision) !== String(row.current_revision) ||
      row.profile_hash !== energyProfileHash(row.current_profile) ||
      row.prediction.targetSoc !== preparation.target_soc ||
      new Date(row.expires_at).getTime() <= Date.now() ||
      new Date(row.ends_at).getTime() <= Date.now() ||
      new Date(row.starts_at).getTime() > Date.now() ||
      new Date(preparation.ends_at).getTime() !==
        new Date(row.ends_at).getTime() ||
      JSON.stringify(
        nightNativeWindows(row.prediction, row.profile.timezone),
      ) !== JSON.stringify(preparation.planned_windows)
    )
      throw new SecurityError(
        409,
        "Night savings permission or forecast changed",
      );
  }
  /** @param {object} runtime @returns {Promise<void>} */
  async release(runtime) {
    await runtime.outage.load();
    if (!runtime.outage.active || runtime.outage.row.purpose !== "night")
      return;
    try {
      await runtime.queue(() => runtime.outage.stop(), 10);
    } catch (error) {
      await runtime.health?.controlFault(true);
      throw error;
    }
  }
  /** @param {object} runtime @param {object} settings @param {object} plan @returns {Promise<void>} */
  async begin(runtime, settings, plan) {
    const claimed = await this.pool.query(
      "UPDATE energy_plans SET state='starting',updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2 AND state='scheduled' RETURNING id",
      [runtime.tenantId, plan.id],
    );
    if (!claimed.rowCount) return;
    try {
      await runtime.outage.load();
      if (runtime.outage.active) throw new Error("outage-priority");
      if (!runtime.outage.status().canPrepare || !runtime.controlEnabled)
        throw new Error("controls-unavailable");
      if (
        settings.approval_binding !==
          commissioningBinding(runtime.account, runtime.verification) ||
        String(settings.revision) !== String(plan.settings_revision)
      )
        throw new Error("permission-changed");
      // The approved ceiling can decrease on new evidence; a one-time plan never silently increases it.
      const current = await this.compute(
        runtime,
        settings,
        plan.prediction.reasons.includes("manual-target")
          ? { targetSoc: plan.prediction.targetSoc }
          : {},
      );
      if (!current || current.prediction.action === "normal")
        throw new Error(current ? "no-topup-needed" : "forecast-unavailable");
      if (
        current.prediction.targetSoc > plan.prediction.targetSoc &&
        !settings.automatic
      )
        throw new Error("recommendation-changed");
      const prediction = current.prediction;
      await this.pool.query(
        "DELETE FROM energy_plans WHERE tenant_id=$1 AND id=$2 AND state='recommended'",
        [runtime.tenantId, current.id],
      );
      const updated = (
        await this.pool.query(
          "UPDATE energy_plans SET prediction=$3,reading=$4,demand=$5,forecast_id=$6,starts_at=$7,ends_at=$8,updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2 AND state='starting' RETURNING *",
          [
            runtime.tenantId,
            plan.id,
            prediction,
            current.reading,
            current.demand,
            current.forecast_id,
            new Date(prediction.night.start),
            new Date(prediction.night.releaseAt),
          ],
        )
      ).rows[0];
      if (
        !updated ||
        new Date(updated.ends_at).getTime() <= Date.now() + 5 * 60000
      )
        throw new Error("charging-window-missed");
      const user = (
        await this.pool.query(
          "SELECT id,email,tenant_id FROM users WHERE id=$1 AND tenant_id=$2",
          [plan.approved_by, runtime.tenantId],
        )
      ).rows[0];
      if (!user) throw new Error("permission-changed");
      await runtime.outage.prepare(
        user,
        { targetSoc: prediction.targetSoc },
        plan.id,
        {
          planId: plan.id,
          endsAt: updated.ends_at,
          windows: nightNativeWindows(prediction, settings.profile.timezone),
        },
      );
    } catch (error) {
      const code = [
        "outage-priority",
        "controls-unavailable",
        "permission-changed",
        "no-topup-needed",
        "recommendation-changed",
        "charging-window-missed",
        "forecast-unavailable",
      ].includes(error.message)
        ? error.message
        : "start-unconfirmed";
      await this.pool.query(
        "UPDATE energy_plans SET state=CASE WHEN $3='no-topup-needed' THEN 'skipped' ELSE 'blocked' END,code=$3,updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2 AND state='starting'",
        [runtime.tenantId, plan.id, code],
      );
    }
  }
  /** @returns {Promise<void>} */
  async tick() {
    if (this.stopping || this.hub.stopping) return;
    try { await this.experience.tick(); }
    catch { console.error(JSON.stringify({ event: "energy_tools_delayed" })); }
    const due = (
      await this.pool.query(
        "SELECT s.* FROM energy_settings s JOIN tenants t ON t.id=s.tenant_id WHERE t.lifecycle='active' AND (s.automatic OR EXISTS(SELECT 1 FROM energy_plans p WHERE p.tenant_id=s.tenant_id AND p.state=ANY($1::text[]))) AND ($2::uuid IS NULL OR s.tenant_id>$2) ORDER BY s.tenant_id LIMIT 200",
        [PENDING, this.cursor],
      )
    ).rows;
    this.cursor = due.length === 200 ? due.at(-1).tenant_id : null;
    for (const settings of due) {
      if (this.stopping) break;
      const runtime = await this.hub.forTenant(settings.tenant_id);
      await runtime.outage.load();
      if (runtime.outage.active && runtime.outage.row.purpose === "night") {
        const stopAt = new Date(runtime.outage.row.ends_at).getTime();
        if (stopAt <= Date.now() || !settings.approval_binding) {
          await this.release(runtime);
          continue;
        }
      }
      const plan = (
        await this.pool.query(
          "SELECT * FROM energy_plans WHERE tenant_id=$1 AND state=ANY($2::text[]) ORDER BY created_at DESC LIMIT 1",
          [settings.tenant_id, PENDING],
        )
      ).rows[0];
      if (plan && ["starting", "running", "restoring"].includes(plan.state)) {
        const preparation = (
          await this.pool.query(
            "SELECT state,last_error FROM outage_preparations WHERE tenant_id=$1 AND energy_plan_id=$2 ORDER BY created_at DESC LIMIT 1",
            [settings.tenant_id, plan.id],
          )
        ).rows[0];
        if (preparation) {
          const state =
            preparation.state === "restored"
              ? "completed"
              : preparation.state === "failed"
                ? "failed"
                : ["restoring", "recovery-required", "quarantined"].includes(
                      preparation.state,
                    )
                  ? "restoring"
                  : preparation.state === "active"
                    ? "running"
                    : "starting";
          if (state !== plan.state) {
            if (state === "completed")
              await this.assess(
                runtime,
                settings.profile,
                await this.readings(runtime),
              );
            await this.pool.query(
              "UPDATE energy_plans SET state=$3,code=$4,updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2",
              [settings.tenant_id, plan.id, state, preparation.last_error],
            );
          }
        } else if (Date.now() - new Date(plan.updated_at).getTime() > 5 * 60000)
          await this.pool.query(
            "UPDATE energy_plans SET state='blocked',code='start-interrupted',updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2",
            [settings.tenant_id, plan.id],
          );
        continue;
      }
      if (plan) {
        if (new Date(plan.ends_at).getTime() <= Date.now() + 5 * 60000)
          await this.pool.query(
            "UPDATE energy_plans SET state='skipped',code='charging-window-missed',updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2",
            [settings.tenant_id, plan.id],
          );
        else if (new Date(plan.starts_at).getTime() <= Date.now())
          await this.begin(runtime, settings, plan);
        continue;
      }
      if (
        !settings.automatic ||
        this.pending.size >= 50 ||
        runtime.outage.active ||
        this.pending.has(settings.tenant_id)
      )
        continue;
      if (
        settings.approval_binding !==
          commissioningBinding(runtime.account, runtime.verification) ||
        !runtime.controlEnabled
      ) {
        await this.pool.query(
          "UPDATE energy_settings SET automatic=false,approval_binding=null,last_code='permission-changed',revision=revision+1 WHERE tenant_id=$1",
          [settings.tenant_id],
        );
        continue;
      }
      const window = energyNightWindows(settings.profile, Date.now())[0];
      const already = await this.pool.query(
        "SELECT 1 FROM energy_plans WHERE tenant_id=$1 AND starts_at=$2 AND approved_by IS NOT NULL LIMIT 1",
        [settings.tenant_id, new Date(window.start)],
      );
      if (
        already.rowCount ||
        (settings.attempted_at &&
          Date.now() - new Date(settings.attempted_at).getTime() < 3600000)
      )
        continue;
      await this.pool.query(
        "UPDATE energy_settings SET attempted_at=clock_timestamp(),last_code='calculating' WHERE tenant_id=$1",
        [settings.tenant_id],
      );
      const pending = this.calculations.enqueue(async () => {
        const recommendation = await this.compute(runtime, settings);
        if (recommendation) {
          const client = await this.pool.connect();
          try {
            await client.query("BEGIN");
            await this.admitNight(
              client,
              settings.tenant_id,
              recommendation.ends_at,
            );
            await client.query(
              "UPDATE energy_plans SET state='scheduled',approved_by=$3,approved_snapshot=jsonb_build_object('profile',profile,'demand',demand,'reading',reading,'forecastId',forecast_id,'prediction',prediction),code=null WHERE tenant_id=$1 AND id=$2 AND EXISTS(SELECT 1 FROM energy_settings s WHERE s.tenant_id=$1 AND s.automatic AND s.revision=$4 AND s.approval_binding=$5)",
              [
                settings.tenant_id,
                recommendation.id,
                settings.approved_by,
                settings.revision,
                settings.approval_binding,
              ],
            );
            await client.query("COMMIT");
          } catch (error) {
            await client.query("ROLLBACK");
            if (!(error instanceof SecurityError)) throw error;
            await this.pool.query(
              "UPDATE energy_plans SET state='blocked',code='deadline-capacity',approved_by=$3 WHERE tenant_id=$1 AND id=$2 AND state='recommended'",
              [settings.tenant_id, recommendation.id, settings.approved_by],
            );
          } finally {
            client.release();
          }
        }
      });
      this.pending.set(settings.tenant_id, pending);
      void pending
        .catch(() => {
          console.error(
            JSON.stringify({ event: "automatic_energy_planning_unavailable" }),
          );
        })
        .finally(() => this.pending.delete(settings.tenant_id));
    }
  }
  /** @returns {Promise<void>} */
  async releaseDue() {
    if (this.stopping || this.hub.stopping) return;
    const rows = (
      await this.pool.query(
        "SELECT p.tenant_id FROM outage_preparations p LEFT JOIN energy_settings s ON s.tenant_id=p.tenant_id JOIN tenants t ON t.id=p.tenant_id WHERE p.purpose='night' AND p.state IN('queued','applying','active','restoring','recovery-required') AND t.lifecycle='active' AND (p.ends_at<=clock_timestamp() OR s.approval_binding IS NULL) ORDER BY p.ends_at LIMIT 200",
      )
    ).rows;
    for (const row of rows) {
      if (this.releasing.has(row.tenant_id)) continue;
      const work = this.hub
        .forTenant(row.tenant_id)
        .then((runtime) => this.release(runtime));
      this.releasing.set(row.tenant_id, work);
      void work
        .catch(() => {
          console.error(JSON.stringify({ event: "night_release_pending" }));
        })
        .finally(() => {
          const timer = setTimeout(
            () => this.releasing.delete(row.tenant_id),
            60000,
          );
          timer.unref();
        });
    }
  }
  /** @returns {void} */
  start() {
    if (this.timer || this.stopping) return;
    const run = () => {
      if (!this.cycle)
        this.cycle = this.tick()
          .catch(() => {
            console.error(
              JSON.stringify({ event: "energy_scheduler_delayed" }),
            );
          })
          .finally(() => {
            this.cycle = null;
          });
    };
    this.timer = setInterval(run, 15000);
    this.timer.unref();
    const deadlines = () => {
      if (!this.releaseCycle)
        this.releaseCycle = this.releaseDue()
          .catch(() => {
            console.error(
              JSON.stringify({ event: "night_deadline_check_delayed" }),
            );
          })
          .finally(() => {
            this.releaseCycle = null;
          });
    };
    this.releaseTimer = setInterval(deadlines, 15000);
    this.releaseTimer.unref();
    run();
    deadlines();
  }
  /** @returns {Promise<void>} */
  async stop() {
    this.stopping = true;
    clearInterval(this.timer);
    clearInterval(this.releaseTimer);
    this.timer = null;
    this.releaseTimer = null;
    this.abort.abort();
    await this.cycle;
    await this.releaseCycle;
    await Promise.allSettled([...this.releasing.values()]);
    await Promise.allSettled([...this.pending.values()]);
    await this.experience.stop();
  }
}
