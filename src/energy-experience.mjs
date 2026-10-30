import { createHash, randomUUID } from "node:crypto";
import { AccountSecurity, SecurityError } from "./account-security.mjs";
import { requireActiveTenant } from "./tenant-lifecycle.mjs";
import { energyProfileHash, energySiteHash, missingEnergyInputs } from "./energy-profile.mjs";
import { energyLocalTime } from "./energy-time.mjs";
import { localDay, dayStart } from "./analytics.mjs";
import { enqueueNotification } from "./notification-store.mjs";
import { validateOutageRequest, validateLoadTask, weeklyEnergyReport, energyLearning } from "./energy-tools-model.mjs";
import { calculateEnergyTool } from "./energy-calculation.mjs";
import { WorkQueue } from "./work-queue.mjs";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

/** @param {object} runtime @param {object} profile @returns {string} */
function taskBinding(runtime, profile) {
  return createHash("sha256").update(JSON.stringify({ account: runtime.account?.id, device: runtime.device, profile: energyProfileHash(profile) })).digest("hex");
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
    this.stopping = false;
    this.calculations = new WorkQueue();
  }

  /** @param {'outage'|'load'} action @param {object} context @param {object} request @returns {Promise<object>} */
  async calculate(action, context, request) {
    if (this.calculations.items.length >= 10 || this.stopping)
      throw new SecurityError(429, "Energy calculations are busy. Try again shortly");
    return this.calculations.enqueue(() => calculateEnergyTool(action, {
      profile: context.profile, rows: context.rows, solar: context.forecast?.slots ?? [], request,
    }, this.hub.energy.abort.signal));
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
    return (await this.pool.query("SELECT revision::text,briefings_enabled AS \"briefingsEnabled\",morning_minute AS \"morningMinute\",evening_minute AS \"eveningMinute\" FROM energy_experience_settings WHERE tenant_id=$1", [tenantId])).rows[0]
      ?? { revision: "0", briefingsEnabled: false, morningMinute: 435, eveningMinute: 1140 };
  }

  /** @param {object} runtime @returns {Promise<object>} */
  async status(runtime) {
    const context = await this.context(runtime), ready = missingEnergyInputs(context.profile).length === 0;
    const [preferences, tasks, briefings] = await Promise.all([
      this.preferences(runtime.tenantId),
      this.pool.query("SELECT id,revision::text,name,power_kw AS \"powerKw\",duration_minutes AS \"durationMinutes\",earliest_at AS \"earliestAt\",deadline_at AS \"deadlineAt\",suggested_at AS \"suggestedAt\",recommendation,reminder_enabled AS \"reminderEnabled\",reminded_at AS \"remindedAt\",state,account_id,device,binding FROM energy_load_tasks WHERE tenant_id=$1 ORDER BY (state='planned') DESC,deadline_at DESC,id LIMIT 50", [runtime.tenantId]),
      this.pool.query("SELECT day,kind,payload,created_at AS \"createdAt\" FROM energy_briefing_receipts WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 14", [runtime.tenantId]),
    ]);
    return {
      ready, energyRevision: String(context.settings.revision), preferences,
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
    const hash = await this.security.confirmedPassword(session.id, body.currentPassword);
    await this.security.withUser(session.id, async (client, user) => {
      await this.security.activeSession(client, session);
      if (user.tenant_id !== runtime.tenantId || user.password_hash !== hash)
        throw new SecurityError(409, "Your account changed. Refresh this page and try again.");
      await client.query("SELECT id FROM tenants WHERE id=$1 FOR UPDATE", [runtime.tenantId]);
      await requireActiveTenant(client, runtime.tenantId);
      const existing = (await client.query("SELECT revision::text FROM energy_experience_settings WHERE tenant_id=$1 FOR UPDATE", [runtime.tenantId])).rows[0];
      if ((existing?.revision ?? "0") !== body.revision) throw new SecurityError(409, "Energy tools settings changed. Refresh before saving");
      if (body.briefingsEnabled && !(await client.query("SELECT 1 FROM notification_channels WHERE tenant_id=$1 AND enabled AND NOT quarantined AND revoked_at IS NULL AND verified_at IS NOT NULL LIMIT 1", [runtime.tenantId])).rowCount)
        throw new SecurityError(409, "Enable a verified notification device before scheduling briefings");
      await client.query("INSERT INTO energy_experience_settings(tenant_id,briefings_enabled,morning_minute,evening_minute) VALUES($1,$2,$3,$4) ON CONFLICT(tenant_id) DO UPDATE SET briefings_enabled=$2,morning_minute=$3,evening_minute=$4,revision=energy_experience_settings.revision+1,updated_at=clock_timestamp()", [runtime.tenantId, body.briefingsEnabled, body.morningMinute, body.eveningMinute]);
      if (!body.briefingsEnabled)
        await client.query("UPDATE notification_outbox SET state=CASE WHEN state IN('queued','retry') THEN 'cancelled' ELSE state END,cancel_requested_at=clock_timestamp(),completed_at=CASE WHEN state IN('queued','retry') THEN clock_timestamp() ELSE completed_at END WHERE tenant_id=$1 AND kind='energy-briefing' AND state IN('queued','retry','sending')", [runtime.tenantId]);
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
    if (body.action === "save") {
      if (missingEnergyInputs(context.profile).length)
        throw new SecurityError(409, "Complete your installation and tariff settings to use energy planning.");
      if (!context.rows.length || Date.now() - new Date(context.rows.at(-1).observed_at).getTime() > 10 * 60000)
        throw new SecurityError(409, "Fresh battery readings are required before scheduling an appliance");
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
      if (body.action === "save") {
        if (!runtime.account?.id || !runtime.device) throw new SecurityError(409, "Select an inverter before planning appliances");
        if (input.reminderEnabled && !(await client.query("SELECT 1 FROM notification_channels WHERE tenant_id=$1 AND enabled AND NOT quarantined AND revoked_at IS NULL AND verified_at IS NOT NULL LIMIT 1", [runtime.tenantId])).rowCount)
          throw new SecurityError(409, "Enable a verified notification device before scheduling reminders");
        if (!existing && (await client.query("SELECT count(*)::int AS n FROM energy_load_tasks WHERE tenant_id=$1 AND state='planned'", [runtime.tenantId])).rows[0].n >= 20)
          throw new SecurityError(409, "Complete or cancel an appliance task before adding more");
        const saved = await client.query("INSERT INTO energy_load_tasks(id,tenant_id,account_id,device,binding,name,power_kw,duration_minutes,earliest_at,deadline_at,suggested_at,recommendation,reminder_enabled) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT(id) DO UPDATE SET account_id=$3,device=$4,binding=$5,name=$6,power_kw=$7,duration_minutes=$8,earliest_at=$9,deadline_at=$10,suggested_at=$11,recommendation=$12,reminder_enabled=$13,reminded_at=null,state='planned',revision=energy_load_tasks.revision+1,updated_at=clock_timestamp() WHERE energy_load_tasks.tenant_id=$2 RETURNING id", [body.id, runtime.tenantId, runtime.account.id, runtime.device, taskBinding(runtime, context.profile), input.name, input.powerKw, input.durationMinutes, new Date(input.earliest), new Date(input.deadline), recommendation.suggestedAt, recommendation, input.reminderEnabled]);
        if (!saved.rowCount) throw new SecurityError(409, "The appliance task changed. Refresh before saving");
      } else {
        if (!existing) throw new SecurityError(404, "Appliance task not found");
        await client.query("UPDATE energy_load_tasks SET state=$3,revision=revision+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2", [runtime.tenantId, body.id, body.action === "done" ? "done" : "cancelled"]);
      }
      await client.query("UPDATE notification_outbox SET state=CASE WHEN state IN('queued','retry') THEN 'cancelled' ELSE state END,cancel_requested_at=clock_timestamp(),completed_at=CASE WHEN state IN('queued','retry') THEN clock_timestamp() ELSE completed_at END WHERE tenant_id=$1 AND kind='energy-reminder' AND event_key LIKE $2 AND state IN('queued','retry','sending')", [runtime.tenantId, `load:${body.id}:%`]);
    });
    return { accepted: true };
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
        if (current.binding === taskBinding(runtime, context.profile) && new Date(current.suggested_at).getTime() >= Date.now() - 15 * 60000 && new Date(current.deadline_at).getTime() > Date.now())
          await this.enqueue(client, runtime.tenantId, `load:${current.id}:${current.revision}`, "energy-reminder", language => ({ title: language === "bg" ? "Напомняне за уред" : "Appliance reminder", text: `${current.name}\n${language === "bg" ? "Препоръчаният час е настъпил. Уредът се включва ръчно." : "The suggested start time has arrived. Start the appliance manually."}` }), Math.min(new Date(current.deadline_at).getTime(), Date.now() + 30 * 60000));
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
    return task.binding === taskBinding(runtime, settings.profile)
      && task.account_id === runtime.account?.id && task.device === runtime.device;
  }

  /** @returns {Promise<void>} */
  async tick() {
    if (this.stopping || this.hub.stopping) return;
    const [preferences, tasks] = await Promise.all([
      this.pool.query("SELECT s.*,a.timezone,COALESCE((SELECT jsonb_agg(b.kind) FROM energy_briefing_receipts b WHERE b.tenant_id=s.tenant_id AND b.day=(clock_timestamp() AT TIME ZONE a.timezone)::date),'[]') AS sent_kinds FROM energy_experience_settings s JOIN tenants t ON t.id=s.tenant_id JOIN solarman_accounts a ON a.tenant_id=s.tenant_id WHERE s.briefings_enabled AND t.lifecycle='active' AND EXISTS(SELECT 1 FROM notification_channels c WHERE c.tenant_id=s.tenant_id AND c.enabled AND NOT c.quarantined AND c.revoked_at IS NULL) AND ($1::uuid IS NULL OR s.tenant_id>$1) ORDER BY s.tenant_id LIMIT 5", [this.cursor]),
      this.pool.query("SELECT id,tenant_id,revision FROM energy_load_tasks WHERE state='planned' AND reminder_enabled AND reminded_at IS NULL AND suggested_at<=clock_timestamp() ORDER BY suggested_at LIMIT 10"),
    ]);
    this.cursor = preferences.rows.length === 5 ? preferences.rows.at(-1).tenant_id : null;
    const queue = (key, work) => {
      if (this.pending.has(key) || this.pending.size >= 5) return;
      const promise = work().catch(() => { console.error(JSON.stringify({ event: "energy_briefing_delayed" })); }).finally(() => this.pending.delete(key));
      this.pending.set(key, promise);
    };
    for (const task of tasks.rows) queue(task.id, () => this.remind(task));
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
