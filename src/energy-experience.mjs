import { randomUUID } from "node:crypto";
import { AccountSecurity, SecurityError } from "./account-security.mjs";
import { requireActiveTenant } from "./tenant-lifecycle.mjs";
import { energyInstallationBinding, energySiteHash, missingEnergyInputs } from "./energy-profile.mjs";
import { energyLocalTime } from "./energy-time.mjs";
import { localDay, dayStart } from "./analytics.mjs";
import { enqueueNotification } from "./notification-store.mjs";
import { validateOutageRequest, validateLoadTask, weeklyEnergyReport, energyLearning } from "./energy-tools-model.mjs";
import { calculateEnergyTool } from "./energy-calculation.mjs";
import { WorkQueue } from "./work-queue.mjs";
import { EnergyAway } from "./energy-away.mjs";
import { EnergyInsights } from "./energy-insights.mjs";
import { EnergyOutageWatch } from "./energy-outage-watch.mjs";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

/** @param {object} runtime @param {object} profile @returns {string} */
function taskBinding(runtime, profile) {
  return energyInstallationBinding(runtime.account?.id ?? null, runtime.device, profile);
}

/** @param {object} context @param {'morning'|'evening'} kind @param {number} now @returns {object} */
function briefingSummary(context, kind, now) {
  const { profile, rows, plan, forecast } = context, latest = rows.at(-1);
  const tomorrow = new Date(`${localDay(now, profile.timezone)}T12:00:00Z`);
  if (kind === "evening") tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const day = tomorrow.toISOString().slice(0, 10);
  const slots = forecast?.slots.filter(s => localDay(s.start, profile.timezone) === day) ?? [];
  const next = new Date(tomorrow); next.setUTCDate(next.getUTCDate() + 1);
  const expectedHours = (dayStart(next.toISOString().slice(0, 10), profile.timezone) - dayStart(day, profile.timezone)) / 3600000;
  const previous = context.plans.find(p => new Date(p.ends_at).getTime() <= now);
  const preparation = previous && context.preparation?.energy_plan_id === previous.id ? context.preparation : null;
  return { kind, at: new Date(now).toISOString(), day: localDay(now, profile.timezone),
    currentSoc: latest && now - new Date(latest.observed_at).getTime() <= 10 * 60000 ? latest.soc : null, readingAt: latest ? new Date(latest.observed_at).toISOString() : null,
    forecastDay: day, forecastSolarKwh: slots.length === expectedHours ? slots.reduce((n, s) => n + s.expectedKw * (s.end - s.start) / 3600000, 0) : null,
    plan: plan ? { state: plan.state, targetSoc: plan.prediction.targetSoc, startsAt: plan.starts_at, endsAt: plan.ends_at, estimatedSavings: plan.prediction.estimatedSavings } : null,
    currency: profile.tariff.currency,
    result: previous ? { state: previous.state, targetSoc: previous.prediction.targetSoc,
      gridChargeObserved: Boolean(preparation?.proof?.gridChargingObservedAt),
      targetStopObserved: Boolean(preparation?.proof?.targetHoldObservedAt),
      normalRestored: preparation?.state === "restored" && preparation?.proof?.restoreWritesVerified === true,
      restoredAt: preparation?.proof?.restoredAt ?? null } : null,
  };
}

/** @param {object} summary @param {'en'|'bg'} language @returns {{title:string,text:string}} */
function briefingMessage(summary, language) {
  const bg = language === "bg", title = summary.kind === "morning" ? (bg ? "Сутрешен енергиен отчет" : "Morning energy briefing") : (bg ? "Вечерен енергиен план" : "Evening energy plan");
  const parts = [title];
  if (summary.currentSoc !== null) parts.push((bg ? "Батерия: " : "Battery: ") + summary.currentSoc + "%");
  if (summary.forecastSolarKwh !== null) parts.push((summary.kind === "morning"
    ? (bg ? "Очаквана слънчева енергия днес: " : "Expected solar today: ")
    : (bg ? "Очаквана слънчева енергия утре: " : "Expected solar tomorrow: ")) + summary.forecastSolarKwh.toFixed(1) + " kWh");
  if (summary.plan) parts.push((bg ? "Нощна цел: " : "Night target: ") + summary.plan.targetSoc + "%");
  if (summary.kind === "morning" && summary.result)
    parts.push(summary.result.normalRestored ? (bg ? "Възстановяването на нормалния режим е потвърдено." : "Restoration of normal settings is confirmed.") : (bg ? "Прегледайте резултата от предишния нощен план в таблото." : "Review the previous night plan result in the dashboard."));
  parts.push(bg ? "Отворете таблото за потвърденото състояние и подробностите." : "Open the dashboard for the confirmed state and details.");
  return { title, text: parts.join("\n") };
}

export class EnergyExperience {
  /** @param {import('pg').Pool} pool @param {object} hub */
  constructor(pool, hub) {
    this.pool = pool;
    this.hub = hub;
    this.security = new AccountSecurity(pool);
    this.pending = new Map();
    this.cursor = null;
    this.assistantCursor = null;
    this.stopping = false;
    this.calculations = new WorkQueue();
    this.away = new EnergyAway(pool, hub);
    this.insights = new EnergyInsights(this);
    this.outageWatch = new EnergyOutageWatch(this);
  }

  /** @param {'outage'|'load'|'schedule'|'away'|'normal-demand'|'insights'|'publication'} action @param {object} context @param {object} request @returns {Promise<object>} */
  async calculate(action, context, request) {
    if (this.calculations.items.length >= 10 || this.stopping)
      throw new SecurityError(429, "Energy calculations are busy. Try again shortly");
    return this.calculations.enqueue(() => calculateEnergyTool(action, {
      profile: context.profile, rows: context.rows, solar: context.forecast?.slots ?? [], request,
      reservations: context.reservations ?? [], tasks: context.tasks ?? [], occupancy: context.occupancy,
      forecasts: context.forecastRecords ?? [], online: context.online,
    }, this.hub.energy.abort.signal), ["away", "outage", "load"].includes(action) ? 10 : action === "publication" ? -2 : action === "insights" ? -1 : 0);
  }

  /** @param {object} runtime @returns {Promise<object>} */
  async context(runtime) {
    const settings = await this.hub.energy.settings(runtime.tenantId, runtime.timezone), profile = settings.profile;
    const [rows, forecasts, plans, outcomes, preparations] = await Promise.all([
      this.pool.query("SELECT * FROM(SELECT * FROM measurements WHERE tenant_id=$1 AND account_id=$2 AND device=$3 AND observed_at>=clock_timestamp()-interval '8 days' ORDER BY observed_at DESC,id DESC LIMIT 5000)recent ORDER BY observed_at,id", [runtime.tenantId, runtime.account?.id ?? null, runtime.device ?? ""]).then(result => result.rows),
      this.pool.query("SELECT payload,expires_at,fetched_at FROM energy_forecasts WHERE tenant_id=$1 AND site_hash=$2 AND fetched_at>=clock_timestamp()-interval '30 days' ORDER BY fetched_at DESC LIMIT 120", [runtime.tenantId, energySiteHash(profile)]),
      this.pool.query("SELECT * FROM energy_plans WHERE tenant_id=$1 AND account_id=$2 AND device=$3 AND approved_by IS NOT NULL ORDER BY created_at DESC LIMIT 60", [runtime.tenantId, runtime.account?.id ?? null, runtime.device ?? ""]),
      this.pool.query("SELECT DISTINCT ON(day) payload FROM energy_outcomes WHERE tenant_id=$1 AND site_hash=$2 ORDER BY day DESC,assessed_at DESC LIMIT 90", [runtime.tenantId, energySiteHash(profile)]),
      this.pool.query("SELECT energy_plan_id,state,proof FROM outage_preparations WHERE tenant_id=$1 AND account_id=$2 AND device=$3 AND purpose='night' ORDER BY created_at DESC LIMIT 1", [runtime.tenantId, runtime.account?.id ?? null, runtime.device ?? ""]),
    ]);
    const forecast = forecasts.rows[0] && new Date(forecasts.rows[0].expires_at).getTime() > Date.now() ? forecasts.rows[0].payload : null;
    return { settings, profile, rows, forecast, forecastRecords: forecasts.rows, plans: plans.rows, plan: plans.rows[0] ?? null, preparation: preparations.rows[0] ?? null, outcomes: outcomes.rows.map(o => o.payload) };
  }

  /** @param {string} tenantId @returns {Promise<object>} */
  async preferences(tenantId) {
    return (await this.pool.query("SELECT revision::text,briefings_enabled AS \"briefingsEnabled\",morning_minute AS \"morningMinute\",evening_minute AS \"eveningMinute\",insights_enabled AS \"insightsEnabled\",auto_replan AS \"autoReplan\",load_revision::text AS \"loadRevision\",last_replan_at AS \"lastReplanAt\",replan_code AS \"replanCode\" FROM energy_experience_settings WHERE tenant_id=$1", [tenantId])).rows[0]
      ?? { revision: "0", briefingsEnabled: false, morningMinute: 435, eveningMinute: 1140, insightsEnabled: false, autoReplan: false, loadRevision: "0", lastReplanAt: null, replanCode: null };
  }

  /** @param {object} runtime @returns {Promise<object>} */
  async status(runtime) {
    const context = await this.context(runtime), ready = missingEnergyInputs(context.profile).length === 0;
    const [preferences, tasks, briefings, away, insights, outageWatch] = await Promise.all([
      this.preferences(runtime.tenantId),
      this.pool.query("SELECT id,revision::text,name,power_kw AS \"powerKw\",duration_minutes AS \"durationMinutes\",earliest_at AS \"earliestAt\",deadline_at AS \"deadlineAt\",suggested_at AS \"suggestedAt\",recommendation,schedule_code AS \"scheduleCode\",reminder_enabled AS \"reminderEnabled\",reminded_at AS \"remindedAt\",state,account_id,device,binding FROM energy_load_tasks WHERE tenant_id=$1 ORDER BY (state='planned') DESC,deadline_at DESC,id LIMIT 50", [runtime.tenantId]),
      this.pool.query("SELECT day,kind,payload,created_at AS \"createdAt\" FROM energy_briefing_receipts WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 14", [runtime.tenantId]),
      this.away.context(runtime, context.profile),
      this.insights.status(runtime, context.profile),
      this.outageWatch.status(runtime),
    ]);
    return {
      ready, energyRevision: String(context.settings.revision), preferences, insights, outageWatch, away: { revision: away.revision, periods: away.periods, canChange: runtime.lifecycle === "active" },
      forecastFresh: Boolean(context.forecast),
      tasks: tasks.rows.map(t => ({ ...t, currentBinding: t.binding === taskBinding(runtime, context.profile) && t.account_id === runtime.account?.id && t.device === runtime.device, binding: undefined, account_id: undefined, device: undefined })),
      briefings: briefings.rows,
      report: ready ? weeklyEnergyReport(context.profile, context.rows, context.plans) : null,
      learning: ready ? energyLearning(context.outcomes, context.rows, { timezone: context.profile.timezone, forecasts: context.forecastRecords }) : null,
      nextBriefing: ready ? briefingSummary(context, "evening", Date.now()) : null,
    };
  }

  /** @param {object} session @param {object} runtime @param {object} body @returns {Promise<object>} */
  async changePreferences(session, runtime, body) {
    if (typeof body.revision !== "string" || !/^\d{1,18}$/.test(body.revision) || typeof body.briefingsEnabled !== "boolean" || ![body.morningMinute, body.eveningMinute].every(v => Number.isInteger(v) && v >= 0 && v < 1440) || body.morningMinute === body.eveningMinute)
      throw new SecurityError(400, "Choose valid briefing times and the current settings revision");
    if ([body.insightsEnabled, body.autoReplan].some(value => value !== undefined && typeof value !== "boolean"))
      throw new SecurityError(400, "Choose whether to enable insights and automatic replanning");
    const hash = await this.security.confirmedPassword(session.id, body.currentPassword);
    await this.security.withUser(session.id, async (client, user) => {
      await this.security.activeSession(client, session);
      if (user.tenant_id !== runtime.tenantId || user.password_hash !== hash)
        throw new SecurityError(409, "Your account changed. Refresh this page and try again.");
      await client.query("SELECT id FROM tenants WHERE id=$1 FOR UPDATE", [runtime.tenantId]);
      await requireActiveTenant(client, runtime.tenantId);
      const existing = (await client.query("SELECT *,revision::text FROM energy_experience_settings WHERE tenant_id=$1 FOR UPDATE", [runtime.tenantId])).rows[0];
      if (this.hub.accountUpdates.has(runtime.tenantId)) throw new SecurityError(409, "An account update is already in progress");
      if ((existing?.revision ?? "0") !== body.revision) throw new SecurityError(409, "Energy tools settings changed. Refresh before saving");
      const insightsEnabled = body.insightsEnabled ?? existing?.insights_enabled ?? false;
      const autoReplan = body.autoReplan ?? existing?.auto_replan ?? false;
      if (insightsEnabled || autoReplan) {
        const energy = (await client.query("SELECT profile FROM energy_settings WHERE tenant_id=$1", [runtime.tenantId])).rows[0];
        if (!energy || missingEnergyInputs(energy.profile).length) throw new SecurityError(409, "Complete your installation and tariff settings to use energy planning.");
      }
      if ((body.briefingsEnabled || insightsEnabled) && !(await client.query("SELECT 1 FROM notification_channels WHERE tenant_id=$1 AND enabled AND NOT quarantined AND revoked_at IS NULL AND verified_at IS NOT NULL LIMIT 1", [runtime.tenantId])).rowCount)
        throw new SecurityError(409, "Enable a verified notification device before scheduling briefings");
      await client.query("INSERT INTO energy_experience_settings(tenant_id,briefings_enabled,morning_minute,evening_minute,insights_enabled,auto_replan) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(tenant_id) DO UPDATE SET briefings_enabled=$2,morning_minute=$3,evening_minute=$4,insights_enabled=$5,auto_replan=$6,revision=energy_experience_settings.revision+1,updated_at=clock_timestamp()", [runtime.tenantId, body.briefingsEnabled, body.morningMinute, body.eveningMinute, insightsEnabled, autoReplan]);
      if (insightsEnabled && !existing?.insights_enabled) await client.query("UPDATE energy_experience_settings SET insights_checked_at=null,insights_assessment=null WHERE tenant_id=$1", [runtime.tenantId]);
      if (!body.briefingsEnabled)
        await client.query("UPDATE notification_outbox SET state=CASE WHEN state IN('queued','retry') THEN 'cancelled' ELSE state END,cancel_requested_at=clock_timestamp(),completed_at=CASE WHEN state IN('queued','retry') THEN clock_timestamp() ELSE completed_at END WHERE tenant_id=$1 AND kind='energy-briefing' AND state IN('queued','retry','sending')", [runtime.tenantId]);
      if (!insightsEnabled) await this.cancelMessages(client, runtime.tenantId, "energy-insight");
    });
    return this.preferences(runtime.tenantId);
  }

  /** @param {object} runtime @param {object} body @returns {Promise<object>} */
  async outage(runtime, body) {
    const context = await this.context(runtime);
    try {
      const request = validateOutageRequest(body, Date.now());
      return await this.calculate("outage", context, request);
    } catch (error) { if (error instanceof SecurityError) throw error; throw new SecurityError(400, error.message); }
  }

  /** @param {object} session @param {object} runtime @param {object} body @returns {Promise<object>} */
  async task(session, runtime, body) {
    if (typeof body.id !== "string" || !UUID.test(body.id) || !["save", "done", "cancel"].includes(body.action) || typeof body.revision !== "string" || !/^\d{1,18}$/.test(body.revision))
      throw new SecurityError(400, "Choose a valid appliance task and revision");
    let input = null, recommendation = null;
    const context = await this.context(runtime);
    const schedule = await this.loadSchedule(runtime, context.profile);
    if (body.action === "save") {
      if (missingEnergyInputs(context.profile).length)
        throw new SecurityError(409, "Complete your installation and tariff settings to use energy planning.");
      if (!context.rows.length || Date.now() - new Date(context.rows.at(-1).observed_at).getTime() > 10 * 60000)
        throw new SecurityError(409, "Fresh battery readings are required before scheduling an appliance");
      context.reservations = schedule.tasks.filter(task => task.id !== body.id && task.recommendation)
        .map(task => ({ start: Date.parse(task.suggestedAt), end: Date.parse(task.recommendation.finishesAt), powerKw: task.powerKw }));
      try { input = validateLoadTask(body); recommendation = await this.calculate("load", context, input); }
      catch (error) { if (error instanceof SecurityError) throw error; throw new SecurityError(400, error.message); }
    }
    await this.security.withUser(session.id, async (client, user) => {
      await this.security.activeSession(client, session);
      if (user.tenant_id !== runtime.tenantId) throw new SecurityError(401, "Sign in to continue");
      await client.query("SELECT id FROM tenants WHERE id=$1 FOR UPDATE", [runtime.tenantId]);
      await requireActiveTenant(client, runtime.tenantId);
      const existing = (await client.query("SELECT * FROM energy_load_tasks WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [runtime.tenantId, body.id])).rows[0];
      if (!existing && body.action !== "save") throw new SecurityError(404, "Appliance task not found");
      if (input && existing && body.revision === "0" && String(existing.revision) === "1" && existing.state === "planned"
        && existing.name === input.name && existing.power_kw === input.powerKw && existing.duration_minutes === input.durationMinutes
        && new Date(existing.earliest_at).getTime() === input.earliest && new Date(existing.deadline_at).getTime() === input.deadline
        && existing.reminder_enabled === input.reminderEnabled && existing.binding === taskBinding(runtime, context.profile)) return;
      if (String(existing?.revision ?? 0) !== body.revision) throw new SecurityError(409, "The appliance task changed. Refresh before saving");
      await this.checkSchedule(client, runtime, context, schedule.revision);
      if (body.action === "save") {
        if (!context.forecastRecords[0] || new Date(context.forecastRecords[0].expires_at).getTime() <= Date.now()) throw new SecurityError(409, "Refresh the solar forecast before replanning");
        if (!runtime.account?.id || !runtime.device) throw new SecurityError(409, "Select an inverter before planning appliances");
        if (input.reminderEnabled && !(await client.query("SELECT 1 FROM notification_channels WHERE tenant_id=$1 AND enabled AND NOT quarantined AND revoked_at IS NULL AND verified_at IS NOT NULL LIMIT 1", [runtime.tenantId])).rowCount)
          throw new SecurityError(409, "Enable a verified notification device before scheduling reminders");
        if (!existing && (await client.query("SELECT count(*)::int AS n FROM energy_load_tasks WHERE tenant_id=$1 AND state='planned'", [runtime.tenantId])).rows[0].n >= 20)
          throw new SecurityError(409, "Complete or cancel an appliance task before adding more");
        const saved = await client.query("INSERT INTO energy_load_tasks(id,tenant_id,account_id,device,binding,name,power_kw,duration_minutes,earliest_at,deadline_at,suggested_at,recommendation,reminder_enabled) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT(id) DO UPDATE SET account_id=$3,device=$4,binding=$5,name=$6,power_kw=$7,duration_minutes=$8,earliest_at=$9,deadline_at=$10,suggested_at=$11,recommendation=$12,reminder_enabled=$13,reminded_at=null,state='planned',revision=energy_load_tasks.revision+1,updated_at=clock_timestamp() WHERE energy_load_tasks.tenant_id=$2 RETURNING id", [body.id, runtime.tenantId, runtime.account.id, runtime.device, taskBinding(runtime, context.profile), input.name, input.powerKw, input.durationMinutes, new Date(input.earliest), new Date(input.deadline), recommendation.suggestedAt, recommendation, input.reminderEnabled]);
        if (!saved.rowCount) throw new SecurityError(409, "The appliance task changed. Refresh before saving");
        await client.query("UPDATE energy_load_tasks SET schedule_code='ready' WHERE tenant_id=$1 AND id=$2", [runtime.tenantId, body.id]);
      } else {
        if (!existing) throw new SecurityError(404, "Appliance task not found");
        await client.query("UPDATE energy_load_tasks SET state=$3,revision=revision+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2", [runtime.tenantId, body.id, body.action === "done" ? "done" : "cancelled"]);
      }
      await client.query("INSERT INTO energy_experience_settings(tenant_id,load_revision) VALUES($1,1) ON CONFLICT(tenant_id) DO UPDATE SET load_revision=energy_experience_settings.load_revision+1", [runtime.tenantId]);
      await this.cancelMessages(client, runtime.tenantId, "energy-reminder", `load:${body.id}:%`);
    });
    return { accepted: true };
  }

  /** @param {object} runtime @param {object} profile @returns {Promise<object>} */
  async loadSchedule(runtime, profile) {
    const snapshot = (await this.pool.query("SELECT COALESCE((SELECT load_revision::text FROM energy_experience_settings WHERE tenant_id=$1),'0') AS revision,COALESCE((SELECT jsonb_agg(to_jsonb(l)||jsonb_build_object('revision',l.revision::text)) FROM(SELECT * FROM energy_load_tasks WHERE tenant_id=$1 AND state='planned' ORDER BY deadline_at,id LIMIT 20)l),'[]') AS tasks", [runtime.tenantId])).rows[0];
    return { revision: snapshot.revision, tasks: snapshot.tasks.filter(task => task.binding === taskBinding(runtime, profile) && task.account_id === runtime.account?.id && task.device === runtime.device)
      .map(task => ({ id: task.id, revision: String(task.revision), powerKw: task.power_kw, durationMinutes: task.duration_minutes,
        earliest: new Date(task.earliest_at).getTime(), deadline: new Date(task.deadline_at).getTime(),
        suggestedAt: new Date(task.suggested_at).toISOString(), remindedAt: task.reminded_at, recommendation: task.recommendation })) };
  }

  /** @param {import('pg').PoolClient} client @param {object} runtime @param {object} context @param {string} revision @returns {Promise<void>} */
  async checkSchedule(client, runtime, context, revision) {
    if (this.hub.accountUpdates.has(runtime.tenantId)) throw new SecurityError(409, "An account update is already in progress");
    const current = (await client.query("SELECT s.revision,s.profile,a.id,a.device_sn,COALESCE(x.load_revision::text,'0') AS load_revision FROM energy_settings s JOIN solarman_accounts a ON a.tenant_id=s.tenant_id LEFT JOIN energy_experience_settings x ON x.tenant_id=s.tenant_id WHERE s.tenant_id=$1", [runtime.tenantId])).rows[0];
    if (!current || String(current.revision) !== String(context.settings.revision) || current.id !== runtime.account?.id || current.device_sn !== runtime.device || taskBinding(runtime, current.profile) !== taskBinding(runtime, context.profile) || current.load_revision !== revision)
      throw new SecurityError(409, "The appliance schedule changed. Refresh before replanning");
  }

  /** @param {import('pg').PoolClient} client @param {string} tenantId @param {string} kind @param {string} [pattern] @returns {Promise<void>} */
  async cancelMessages(client, tenantId, kind, pattern = "%") {
    await client.query("UPDATE notification_outbox SET state=CASE WHEN state IN('queued','retry') THEN 'cancelled' ELSE state END,cancel_requested_at=clock_timestamp(),completed_at=CASE WHEN state IN('queued','retry') THEN clock_timestamp() ELSE completed_at END WHERE tenant_id=$1 AND kind=$2 AND event_key LIKE $3 AND state IN('queued','retry','sending')", [tenantId, kind, pattern]);
  }

  /** @param {object|null} session @param {object} runtime @param {object} body @returns {Promise<object>} */
  async replan(session, runtime, body) {
    const context = await this.context(runtime), preferences = await this.preferences(runtime.tenantId);
    if (!session && !preferences.autoReplan) return { accepted: false };
    if (session && body.revision !== preferences.loadRevision) throw new SecurityError(409, "The appliance schedule changed. Refresh before replanning");
    if (missingEnergyInputs(context.profile).length || !context.forecast || !context.rows.length || Date.now() - new Date(context.rows.at(-1).observed_at).getTime() > 10 * 60000)
      throw new SecurityError(409, "Fresh readings and a solar forecast are required before replanning");
    const schedule = await this.loadSchedule(runtime, context.profile);
    context.tasks = schedule.tasks;
    if (session && body.revision !== schedule.revision) throw new SecurityError(409, "The appliance schedule changed. Refresh before replanning");
    const result = await this.calculate("schedule", context, {});
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      if (session) {
        if (!(await client.query("SELECT id FROM users WHERE id=$1 AND tenant_id=$2 FOR UPDATE", [session.id, runtime.tenantId])).rowCount) throw new SecurityError(401, "Sign in to continue");
        await this.security.activeSession(client, session);
      }
      await client.query("SELECT id FROM tenants WHERE id=$1 FOR UPDATE", [runtime.tenantId]);
      await requireActiveTenant(client, runtime.tenantId);
      await this.checkSchedule(client, runtime, context, schedule.revision);
      const current = (await client.query("SELECT * FROM energy_experience_settings WHERE tenant_id=$1 FOR UPDATE", [runtime.tenantId])).rows[0];
      if (!session && (!current?.auto_replan || String(current.revision) !== preferences.revision)) { await client.query("ROLLBACK"); return { accepted: false }; }
      if (!context.forecast || !context.forecastRecords[0] || new Date(context.forecastRecords[0].expires_at).getTime() <= Date.now()) throw new SecurityError(409, "Refresh the solar forecast before replanning");
      let changed = 0;
      for (const item of result.tasks.filter(task => !task.fixed)) {
        const original = schedule.tasks.find(task => task.id === item.id);
        if (original?.remindedAt || Date.parse(original?.suggestedAt ?? "") <= Date.now()) throw new SecurityError(409, "An appliance start time arrived. Refresh before replanning");
        const updated = await client.query("UPDATE energy_load_tasks SET suggested_at=$4,recommendation=$5,schedule_code=$6,revision=revision+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2 AND revision=$3 AND state='planned' AND reminded_at IS NULL RETURNING id", [runtime.tenantId, item.id, original.revision, item.recommendation?.suggestedAt ?? original.suggestedAt, item.recommendation ?? original.recommendation, item.code]);
        if (!updated.rowCount) throw new SecurityError(409, "The appliance schedule changed. Refresh before replanning");
        changed++;
        await this.cancelMessages(client, runtime.tenantId, "energy-reminder", `load:${item.id}:%`);
      }
      await client.query("INSERT INTO energy_experience_settings(tenant_id,load_revision,last_replan_at,replan_forecast_at) VALUES($1,1,clock_timestamp(),$2) ON CONFLICT(tenant_id) DO UPDATE SET load_revision=energy_experience_settings.load_revision+1,last_replan_at=clock_timestamp(),replan_forecast_at=$2", [runtime.tenantId, context.forecastRecords[0].fetched_at]);
      await client.query("UPDATE energy_experience_settings SET replan_code='ready' WHERE tenant_id=$1", [runtime.tenantId]);
      await client.query("COMMIT");
      return { accepted: true, changed, switchesAppliances: false };
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }

  /** @param {import('pg').PoolClient} client @param {string} tenantId @param {string} key @param {string} kind @param {(language:'en'|'bg')=>object} message @param {number} expires @returns {Promise<number>} */
  async enqueue(client, tenantId, key, kind, message, expires) {
    const channels = (await client.query("SELECT * FROM notification_channels WHERE tenant_id=$1 AND enabled AND NOT quarantined AND revoked_at IS NULL AND verified_at IS NOT NULL AND secret IS NOT NULL FOR UPDATE", [tenantId])).rows;
    for (const channel of channels)
      await enqueueNotification(client, channel, { id: randomUUID(), eventKey: key, kind, payload: { ...message(channel.language), url: "/controls/energy-tools", expiresAt: new Date(expires).toISOString() } });
    return channels.length;
  }

  /** @param {object} preference @param {'morning'|'evening'} kind @returns {Promise<void>} */
  async sendBriefing(preference, kind) {
    const day = localDay(Date.now(), preference.timezone);
    if ((await this.pool.query("SELECT 1 FROM energy_briefing_receipts WHERE tenant_id=$1 AND day=$2 AND kind=$3", [preference.tenant_id, day, kind])).rowCount) return;
    if (!(await this.pool.query("SELECT 1 FROM notification_channels WHERE tenant_id=$1 AND enabled AND NOT quarantined AND revoked_at IS NULL LIMIT 1", [preference.tenant_id])).rowCount) return;
    const runtime = await this.hub.forTenant(preference.tenant_id);
    if (kind === "evening") {
      const settings = await this.hub.energy.settings(runtime.tenantId, runtime.timezone);
      if (!missingEnergyInputs(settings.profile).length) {
        try { await this.hub.energy.refresh(runtime, String(settings.revision)); await this.hub.energy.pending.get(runtime.tenantId); }
        catch (error) { if (!(error instanceof SecurityError) || error.status !== 429) throw error; }
      }
    }
    const context = await this.context(runtime), summary = briefingSummary(context, kind, Date.now());
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const allowed = (await client.query("SELECT 1 FROM energy_experience_settings s JOIN tenants t ON t.id=s.tenant_id WHERE s.tenant_id=$1 AND s.revision=$2 AND s.briefings_enabled AND t.lifecycle='active' FOR UPDATE OF s", [preference.tenant_id, preference.revision])).rowCount;
      if (allowed) {
        const receipt = await client.query("INSERT INTO energy_briefing_receipts(tenant_id,day,kind,payload) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING day", [runtime.tenantId, summary.day, kind, summary]);
        if (receipt.rowCount && !(await this.enqueue(client, runtime.tenantId, `briefing:${summary.day}:${kind}`, "energy-briefing", language => briefingMessage(summary, language), Date.now() + 2 * 3600000))) {
          await client.query("ROLLBACK");
          return;
        }
      }
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }

  /** @param {object} task @returns {Promise<void>} */
  async remind(task) {
    const runtime = await this.hub.forTenant(task.tenant_id), context = await this.context(runtime);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const current = (await client.query("SELECT l.* FROM energy_load_tasks l JOIN tenants t ON t.id=l.tenant_id WHERE l.tenant_id=$1 AND l.id=$2 AND l.revision=$3 AND l.state='planned' AND l.reminder_enabled AND l.reminded_at IS NULL AND t.lifecycle='active' FOR UPDATE OF l", [task.tenant_id, task.id, task.revision])).rows[0];
      if (current) {
        let queued = 0;
        if (context.forecast && context.rows.length && Date.now() - new Date(context.rows.at(-1).observed_at).getTime() <= 10 * 60000 && current.recommendation && current.schedule_code !== "window-missed" && current.binding === taskBinding(runtime, context.profile) && new Date(current.suggested_at).getTime() <= Date.now() && new Date(current.suggested_at).getTime() >= Date.now() - 15 * 60000 && Date.now() + current.duration_minutes * 60000 <= new Date(current.deadline_at).getTime())
          queued = await this.enqueue(client, runtime.tenantId, `load:${current.id}:${current.revision}`, "energy-reminder", language => ({ title: language === "bg" ? "Напомняне за уред" : "Appliance reminder", text: `${current.name}\n${language === "bg" ? "Препоръчаният час е настъпил. Уредът се включва ръчно." : "The suggested start time has arrived. Start the appliance manually."}` }), Math.min(new Date(current.deadline_at).getTime(), Date.now() + 15 * 60000));
        if (queued || new Date(current.suggested_at).getTime() < Date.now() - 15 * 60000 || current.binding !== taskBinding(runtime, context.profile) || current.schedule_code === "window-missed")
          await client.query("UPDATE energy_load_tasks SET reminded_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2", [task.tenant_id, task.id]);
      }
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }

  /** @param {object} job @returns {Promise<boolean>} */
  async reminderCurrent(job) {
    const task = (await this.pool.query("SELECT * FROM energy_load_tasks WHERE tenant_id=$1 AND 'load:'||id::text||':'||revision::text=$2 AND state='planned' AND reminder_enabled", [job.tenant_id, job.event_key])).rows[0];
    if (!task) return false;
    const runtime = await this.hub.forTenant(job.tenant_id);
    const settings = await this.hub.energy.settings(runtime.tenantId, runtime.timezone);
    const context = await this.context(runtime);
    return task.binding === taskBinding(runtime, settings.profile)
      && task.account_id === runtime.account?.id && task.device === runtime.device && task.recommendation && task.schedule_code !== "window-missed"
      && context.forecast && context.rows.length > 0 && Date.now() - new Date(context.rows.at(-1).observed_at).getTime() <= 10 * 60000
      && new Date(task.suggested_at).getTime() <= Date.now() && new Date(task.suggested_at).getTime() >= Date.now() - 15 * 60000
      && new Date(task.deadline_at).getTime() >= Date.now() + task.duration_minutes * 60000;
  }

  /** @returns {Promise<void>} */
  async tick() {
    if (this.stopping || this.hub.stopping) return;
    const [preferences, tasks, assistants, watches] = await Promise.all([
      this.pool.query("SELECT s.*,a.timezone,COALESCE((SELECT jsonb_agg(b.kind) FROM energy_briefing_receipts b WHERE b.tenant_id=s.tenant_id AND b.day=(clock_timestamp() AT TIME ZONE a.timezone)::date),'[]') AS sent_kinds FROM energy_experience_settings s JOIN tenants t ON t.id=s.tenant_id JOIN solarman_accounts a ON a.tenant_id=s.tenant_id WHERE s.briefings_enabled AND t.lifecycle='active' AND EXISTS(SELECT 1 FROM notification_channels c WHERE c.tenant_id=s.tenant_id AND c.enabled AND NOT c.quarantined AND c.revoked_at IS NULL) AND ($1::uuid IS NULL OR s.tenant_id>$1) ORDER BY s.tenant_id LIMIT 5", [this.cursor]),
      this.pool.query("SELECT id,tenant_id,revision FROM energy_load_tasks WHERE state='planned' AND reminder_enabled AND reminded_at IS NULL AND suggested_at<=clock_timestamp() ORDER BY suggested_at LIMIT 10"),
      this.pool.query("SELECT s.tenant_id,s.insights_enabled,s.auto_replan FROM energy_experience_settings s JOIN tenants t ON t.id=s.tenant_id WHERE t.lifecycle='active' AND ($1::uuid IS NULL OR s.tenant_id>$1) AND ((s.insights_enabled AND(s.insights_checked_at IS NULL OR s.insights_checked_at<clock_timestamp()-interval '10 minutes')) OR (s.auto_replan AND(s.last_replan_at IS NULL OR s.last_replan_at<clock_timestamp()-interval '30 minutes') AND EXISTS(SELECT 1 FROM energy_forecasts f WHERE f.tenant_id=s.tenant_id AND f.expires_at>clock_timestamp() AND(s.replan_forecast_at IS NULL OR f.fetched_at>s.replan_forecast_at)) AND EXISTS(SELECT 1 FROM energy_load_tasks l WHERE l.tenant_id=s.tenant_id AND l.state='planned' AND l.suggested_at>clock_timestamp() AND l.reminded_at IS NULL))) ORDER BY s.tenant_id LIMIT 5", [this.assistantCursor]),
      this.pool.query("SELECT w.tenant_id FROM energy_outage_watches w JOIN tenants t ON t.id=w.tenant_id WHERE w.enabled AND NOT w.quarantined AND t.lifecycle='active' AND(w.attempted_at IS NULL OR w.attempted_at<clock_timestamp()-interval '3 hours') ORDER BY w.attempted_at NULLS FIRST LIMIT 2"),
    ]);
    this.cursor = preferences.rows.length === 5 ? preferences.rows.at(-1).tenant_id : null;
    this.assistantCursor = assistants.rows.length === 5 ? assistants.rows.at(-1).tenant_id : null;
    const queue = (key, work) => {
      if (this.pending.has(key) || this.pending.size >= 5) return;
      const promise = work().catch(() => { console.error(JSON.stringify({ event: "energy_briefing_delayed" })); }).finally(() => this.pending.delete(key));
      this.pending.set(key, promise);
    };
    for (const task of tasks.rows) queue(task.id, () => this.remind(task));
    for (const assistant of assistants.rows) queue(`assistant:${assistant.tenant_id}`, async () => {
      const runtime = await this.hub.forTenant(assistant.tenant_id);
      if (assistant.insights_enabled) await this.insights.check(runtime);
      if (assistant.auto_replan) {
        try { await this.replan(null, runtime, {}); }
        catch { await this.pool.query("UPDATE energy_experience_settings SET last_replan_at=clock_timestamp(),replan_code='unavailable' WHERE tenant_id=$1", [assistant.tenant_id]); }
      }
    });
    for (const watch of watches.rows) queue(`watch:${watch.tenant_id}`, async () => this.outageWatch.check(await this.hub.forTenant(watch.tenant_id)));
    for (const preference of preferences.rows) {
      const minute = energyLocalTime(Date.now(), preference.timezone).minute;
      for (const kind of ["morning", "evening"])
        if (!preference.sent_kinds.includes(kind) && minute >= preference[`${kind}_minute`] && minute - preference[`${kind}_minute`] < 60)
          queue(`${preference.tenant_id}:${kind}`, () => this.sendBriefing(preference, kind));
    }
  }

  /** @returns {Promise<void>} */
  async stop() {
    this.stopping = true;
    await Promise.allSettled([...this.pending.values()]);
    await this.calculations.idle();
  }
}
