import { createHash, randomUUID } from "node:crypto";
import { AccountSecurity, SecurityError } from "./account-security.mjs";
import { requireActiveTenant } from "./tenant-lifecycle.mjs";
import { energyInstallationBinding, energyProfileHash, missingEnergyInputs } from "./energy-profile.mjs";
import { validateAwayPeriod } from "./energy-occupancy.mjs";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

export class EnergyAway {
  /** @param {import('pg').Pool} pool @param {object} hub */
  constructor(pool, hub) {
    this.pool = pool;
    this.hub = hub;
    this.security = new AccountSecurity(pool);
  }

  /** @param {object} runtime @param {object} profile @returns {Promise<object>} */
  async context(runtime, profile) {
    const binding = energyInstallationBinding(runtime.account?.id ?? null, runtime.device, profile);
    const snapshot = (await this.pool.query("SELECT COALESCE((SELECT away_revision::text FROM energy_experience_settings WHERE tenant_id=$1),'0') AS revision,COALESCE((SELECT jsonb_agg(to_jsonb(p)) FROM(SELECT * FROM energy_away_periods WHERE tenant_id=$1 AND account_id=$2 AND device=$3 ORDER BY starts_at DESC,id LIMIT 100)p),'[]') AS periods", [runtime.tenantId, runtime.account?.id ?? null, runtime.device ?? ""])).rows[0];
    const periods = { rows: snapshot.periods };
    const history = periods.rows.map(p => ({ id: p.id, start: new Date(p.starts_at).getTime(),
      end: Math.min(new Date(p.returns_at).getTime(), p.cancelled_at ? new Date(p.cancelled_at).getTime() : Infinity),
      baselineW: p.baseline_w })).filter(p => p.end > p.start);
    return {
      revision: snapshot.revision, history,
      normalModel: periods.rows.filter(period => period.binding === binding && period.normal_model?.ready)
        .sort((a, b) => Date.parse(b.normal_model.asOf) - Date.parse(a.normal_model.asOf))[0]?.normal_model ?? null,
      future: history.filter(p => periods.rows.some(row => row.id === p.id && row.state === "planned" && row.binding === binding)),
      periods: periods.rows.map(p => ({ id: p.id, startsAt: p.starts_at, returnsAt: p.returns_at,
        baselineW: p.baseline_w, normalHistoryAt: p.normal_model?.asOf ?? null, state: p.state, cancelledAt: p.cancelled_at, currentBinding: p.binding === binding })),
    };
  }

  /** @param {object} runtime @param {object} body @returns {Promise<object>} */
  async preview(runtime, body) {
    let period;
    try { period = validateAwayPeriod(body); }
    catch (error) { throw new SecurityError(400, error.message); }
    const context = await this.hub.energy.experience.context(runtime);
    context.rows = await this.hub.energy.readings(runtime);
    if (missingEnergyInputs(context.profile).length)
      throw new SecurityError(409, "Complete your installation and tariff settings to use energy planning.");
    if (!context.forecast) throw new SecurityError(409, "Refresh the solar forecast before previewing Away mode");
    context.occupancy = await this.context(runtime, context.profile);
    if (context.occupancy.future.some(p => p.start < period.end && p.end > period.start))
      throw new SecurityError(409, "Away periods cannot overlap");
    try {
      const preview = await this.hub.energy.experience.calculate("away", context, period);
      return { ...preview, energyRevision: String(context.settings.revision), awayRevision: context.occupancy.revision };
    }
    catch (error) {
      if (error instanceof SecurityError) throw error;
      throw new SecurityError(409, error.message);
    }
  }

  /** @param {object} session @param {object} runtime @param {object} body @param {unknown} key @returns {Promise<object>} */
  async change(session, runtime, body, key) {
    if (!UUID.test(key ?? "") || !UUID.test(body.id ?? "") || !["save", "cancel"].includes(body.action) ||
      typeof body.revision !== "string" || !/^\d{1,18}$/.test(body.revision) ||
      (body.action === "save" && (typeof body.energyRevision !== "string" || !/^\d{1,18}$/.test(body.energyRevision))) ||
      Object.keys(body).some(k => !["id", "action", "revision", "energyRevision", "startsAt", "returnsAt", "baselineW", "currentPassword"].includes(k)))
      throw new SecurityError(400, "Choose a valid Away request and current revision");
    const hash = await this.security.confirmedPassword(session.id, body.currentPassword);
    const settings = await this.hub.energy.settings(runtime.tenantId, runtime.timezone);
    if (!runtime.account?.id || !runtime.device || (body.action === "save" && missingEnergyInputs(settings.profile).length))
      throw new SecurityError(409, "Complete your installation and tariff settings to use energy planning.");
    const fingerprint = createHash("sha256").update(JSON.stringify({ action: body.action, id: body.id,
      revision: body.revision, energyRevision: body.energyRevision, startsAt: body.startsAt, returnsAt: body.returnsAt, baselineW: body.baselineW })).digest("hex");
    let normalModel = null;
    if (body.action === "save") {
      const context = await this.hub.energy.experience.context(runtime);
      context.rows = await this.hub.energy.readings(runtime);
      context.occupancy = await this.context(runtime, context.profile);
      normalModel = await this.hub.energy.experience.calculate("normal-demand", context, {});
      if (!normalModel.ready) throw new SecurityError(409, "More household readings or a daily consumption estimate are required");
    }
    await this.security.withUser(session.id, async (client, user) => {
      await this.security.activeSession(client, session);
      if (user.tenant_id !== runtime.tenantId || user.password_hash !== hash)
        throw new SecurityError(409, "Your account changed. Refresh this page and try again.");
      await client.query("SELECT id FROM tenants WHERE id=$1 FOR UPDATE", [runtime.tenantId]);
      await requireActiveTenant(client, runtime.tenantId);
      if (this.hub.accountUpdates.has(runtime.tenantId)) throw new SecurityError(409, "An account update is already in progress");
      const prior = (await client.query("SELECT action,result FROM energy_events WHERE tenant_id=$1 AND user_id=$2 AND idempotency_key=$3", [runtime.tenantId, session.id, key])).rows[0];
      if (prior) {
        if (prior.action !== `away-${body.action}` || prior.result.fingerprint !== fingerprint)
          throw new SecurityError(409, "The request identifier was already used for another action");
        return;
      }
      const current = (await client.query("SELECT e.profile,e.revision,a.id,a.device_sn FROM energy_settings e JOIN solarman_accounts a ON a.tenant_id=e.tenant_id WHERE e.tenant_id=$1 FOR SHARE OF e,a", [runtime.tenantId])).rows[0];
      if (!current || (body.action === "save" && String(current.revision) !== body.energyRevision) || energyProfileHash(current.profile) !== energyProfileHash(settings.profile) || current.id !== runtime.account.id || current.device_sn !== runtime.device)
        throw new SecurityError(409, "Energy settings changed; refresh before saving");
      const preference = (await client.query("SELECT away_revision::text AS revision FROM energy_experience_settings WHERE tenant_id=$1 FOR UPDATE", [runtime.tenantId])).rows[0];
      if ((preference?.revision ?? "0") !== body.revision)
        throw new SecurityError(409, "Away dates changed. Refresh before saving");
      const binding = energyInstallationBinding(runtime.account.id, runtime.device, settings.profile);
      const existing = (await client.query("SELECT id FROM energy_away_periods WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [runtime.tenantId, body.id])).rows[0];
      if (body.action === "save") {
        let period;
        try { period = validateAwayPeriod(body); }
        catch (error) { throw new SecurityError(400, error.message); }
        if (existing) throw new SecurityError(409, "Cancel the existing Away period before replacing its dates");
        const active = (await client.query("SELECT starts_at,returns_at FROM energy_away_periods WHERE tenant_id=$1 AND state='planned' AND binding=$2 AND returns_at>clock_timestamp()", [runtime.tenantId, binding])).rows;
        if (active.length >= 10) throw new SecurityError(409, "Keep up to ten future Away periods");
        if (active.some(p => new Date(p.starts_at).getTime() < period.end && new Date(p.returns_at).getTime() > period.start))
          throw new SecurityError(409, "Away periods cannot overlap");
        await client.query("INSERT INTO energy_away_periods(id,tenant_id,account_id,device,binding,starts_at,returns_at,baseline_w,normal_model) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
          [body.id, runtime.tenantId, runtime.account.id, runtime.device, binding, new Date(period.start), new Date(period.end), period.baselineW, normalModel]);
      } else {
        if (!existing) throw new SecurityError(404, "Away period not found");
        await client.query("UPDATE energy_away_periods SET state='cancelled',cancelled_at=COALESCE(cancelled_at,clock_timestamp()),updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2", [runtime.tenantId, body.id]);
      }
      await client.query("INSERT INTO energy_experience_settings(tenant_id,away_revision) VALUES($1,1) ON CONFLICT(tenant_id) DO UPDATE SET away_revision=energy_experience_settings.away_revision+1,updated_at=clock_timestamp()", [runtime.tenantId]);
      await client.query("UPDATE energy_settings SET attempted_at=null WHERE tenant_id=$1", [runtime.tenantId]);
      await client.query("UPDATE energy_plans p SET state='cancelled',code='occupancy-changed',updated_at=clock_timestamp() FROM energy_settings s WHERE s.tenant_id=p.tenant_id AND p.tenant_id=$1 AND s.automatic AND p.state IN('scheduled','recommended') AND p.starts_at>clock_timestamp() AND NOT(p.prediction->'reasons' ? 'manual-target')", [runtime.tenantId]);
      await client.query("INSERT INTO energy_events(id,tenant_id,user_id,idempotency_key,action,result) VALUES($1,$2,$3,$4,$5,$6)", [randomUUID(), runtime.tenantId, session.id, key, `away-${body.action}`, { fingerprint }]);
    });
    return { accepted: true };
  }
}
