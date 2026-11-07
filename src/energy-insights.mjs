import { randomUUID } from "node:crypto";
import { SecurityError } from "./account-security.mjs";
import { energyInstallationBinding } from "./energy-profile.mjs";
import { requireActiveTenant } from "./tenant-lifecycle.mjs";

export class EnergyInsights {
  /** @param {object} experience */
  constructor(experience) { this.experience = experience; this.pool = experience.pool; this.hub = experience.hub; }

  /** @param {object} runtime @param {object} profile @returns {Promise<object>} */
  async status(runtime, profile) {
    const binding = energyInstallationBinding(runtime.account?.id ?? null, runtime.device, profile);
    const [preferences, incidents] = await Promise.all([
      this.pool.query("SELECT insights_enabled,insights_checked_at,insights_assessment FROM energy_experience_settings WHERE tenant_id=$1", [runtime.tenantId]),
      this.pool.query("SELECT id,kind,evidence,first_seen_at AS \"firstSeenAt\",last_seen_at AS \"lastSeenAt\",resolved_at AS \"resolvedAt\",seen_at AS \"seenAt\",snoozed_until AS \"snoozedUntil\" FROM energy_insights WHERE tenant_id=$1 AND binding=$2 ORDER BY first_seen_at DESC LIMIT 10", [runtime.tenantId, binding]),
    ]);
    const current = preferences.rows[0];
    const matching = current?.insights_assessment?.binding === binding;
    return { enabled: current?.insights_enabled ?? false, checkedAt: matching ? current.insights_checked_at : null, assessment: matching ? current.insights_assessment : null, incidents: incidents.rows };
  }

  /** @param {object} runtime @returns {Promise<void>} */
  async check(runtime) {
    const preference = await this.experience.preferences(runtime.tenantId);
    if (!preference.insightsEnabled || !runtime.account?.id || !runtime.device) return;
    const context = await this.experience.context(runtime);
    const [rows, occupancy, health] = await Promise.all([
      this.pool.query("SELECT * FROM(SELECT * FROM measurements WHERE tenant_id=$1 AND account_id=$2 AND device=$3 AND observed_at>=clock_timestamp()-interval '28 days' ORDER BY observed_at DESC,id DESC LIMIT 12000)q ORDER BY observed_at,id", [runtime.tenantId, runtime.account.id, runtime.device]),
      this.experience.away.context(runtime, context.profile),
      this.pool.query("SELECT auth_fault,device_state,failed_at,succeeded_at FROM device_health WHERE tenant_id=$1 AND account_id=$2 AND device=$3", [runtime.tenantId, runtime.account.id, runtime.device]),
    ]);
    const state = health.rows[0], failed = state?.failed_at && (!state.succeeded_at || new Date(state.failed_at).getTime() > new Date(state.succeeded_at).getTime());
    const online = !state?.auth_fault && !failed && (state?.device_state == null || state.device_state === 1) && (runtime.telemetry?.deviceState === undefined || runtime.telemetry.deviceState === 1);
    const assessment = await this.experience.calculate("insights", { ...context, rows: rows.rows, occupancy, online }, {});
    const binding = energyInstallationBinding(runtime.account.id, runtime.device, context.profile), client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT id FROM tenants WHERE id=$1 FOR UPDATE", [runtime.tenantId]);
      await requireActiveTenant(client, runtime.tenantId);
      if (this.hub.accountUpdates.has(runtime.tenantId)) { await client.query("ROLLBACK"); return; }
      const setting = (await client.query("SELECT s.profile,a.id,a.device_sn,x.insights_enabled,x.revision::text FROM energy_settings s JOIN solarman_accounts a ON a.tenant_id=s.tenant_id JOIN energy_experience_settings x ON x.tenant_id=s.tenant_id WHERE s.tenant_id=$1 FOR UPDATE OF x", [runtime.tenantId])).rows[0];
      if (!setting?.insights_enabled || setting.revision !== preference.revision || energyInstallationBinding(setting.id, setting.device_sn, setting.profile) !== binding) { await client.query("ROLLBACK"); return; }
      await client.query("UPDATE energy_insights SET resolved_at=clock_timestamp(),resolution_reason='binding-changed' WHERE tenant_id=$1 AND binding<>$2 AND resolved_at IS NULL", [runtime.tenantId, binding]);
      for (const evidence of [assessment.consumption, assessment.solar]) {
        if (!["healthy", "active"].includes(evidence.state)) continue;
        const current = (await client.query("SELECT * FROM energy_insights WHERE tenant_id=$1 AND binding=$2 AND kind=$3 AND resolved_at IS NULL FOR UPDATE", [runtime.tenantId, binding, evidence.kind])).rows[0];
        if (evidence.state === "healthy") {
          if (current) {
            await client.query("UPDATE energy_insights SET resolved_at=clock_timestamp(),resolution_reason='cleared' WHERE id=$1", [current.id]);
            await this.experience.cancelMessages(client, runtime.tenantId, "energy-insight", `insight:${current.id}`);
          }
          continue;
        }
        const id = current?.id ?? randomUUID();
        await client.query("INSERT INTO energy_insights(id,tenant_id,account_id,device,binding,kind,evidence,first_seen_at,last_seen_at) VALUES($1,$2,$3,$4,$5,$6,$7,clock_timestamp(),clock_timestamp()) ON CONFLICT(id) DO UPDATE SET evidence=$7,last_seen_at=clock_timestamp()", [id, runtime.tenantId, runtime.account.id, runtime.device, binding, evidence.kind, evidence]);
        const cooldown = (await client.query("SELECT 1 FROM energy_insights WHERE tenant_id=$1 AND kind=$2 AND notified_at>clock_timestamp()-interval '24 hours' LIMIT 1", [runtime.tenantId, evidence.kind])).rowCount;
        if (!current?.notified_at && !cooldown && (!current?.snoozed_until || new Date(current.snoozed_until).getTime() <= Date.now())) {
          const channels = await this.experience.enqueue(client, runtime.tenantId, `insight:${id}`, "energy-insight", language => {
            const bg = language === "bg", high = evidence.kind === "consumption-high";
            return { title: high ? bg ? "Необичайно потребление за един час" : "Unusual household use for an hour" : bg ? "Слънчевото производство е под прогнозата" : "Solar production is below forecast",
              text: bg ? "Прегледайте измерванията и сравнението в енергийния асистент. Това е наблюдение, а не диагноза на уред." : "Review the measurements and comparison in the energy assistant. This observation does not identify an appliance." };
          }, Date.now() + 30 * 60000);
          if (channels) await client.query("UPDATE energy_insights SET notified_at=clock_timestamp() WHERE id=$1", [id]);
        }
      }
      await client.query("UPDATE energy_experience_settings SET insights_checked_at=clock_timestamp(),insights_assessment=$2 WHERE tenant_id=$1", [runtime.tenantId, { ...assessment, binding }]);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }

  /** @param {object} session @param {object} runtime @param {object} body @returns {Promise<object>} */
  async acknowledge(session, runtime, body) {
    if (typeof body.id !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(body.id) || !["seen", "snooze"].includes(body.action)) throw new SecurityError(400, "Choose an insight and an action");
    await this.experience.security.withUser(session.id, async (client, user) => {
      await this.experience.security.activeSession(client, session);
      if (user.tenant_id !== runtime.tenantId) throw new SecurityError(401, "Sign in to continue");
      await client.query("SELECT id FROM tenants WHERE id=$1 FOR UPDATE", [runtime.tenantId]);
      await requireActiveTenant(client, runtime.tenantId);
      const updated = await client.query("UPDATE energy_insights SET seen_at=clock_timestamp(),snoozed_until=CASE WHEN $3='snooze' THEN clock_timestamp()+interval '24 hours' ELSE snoozed_until END WHERE tenant_id=$1 AND id=$2 RETURNING id", [runtime.tenantId, body.id, body.action]);
      if (!updated.rowCount) throw new SecurityError(404, "Energy insight not found");
      if (body.action === "snooze") await this.experience.cancelMessages(client, runtime.tenantId, "energy-insight", `insight:${body.id}`);
    });
    return { accepted: true };
  }

  /** @param {object} job @returns {Promise<boolean>} */
  async current(job) {
    const row = (await this.pool.query(`SELECT i.*,s.profile,a.id AS current_account,a.device_sn
      FROM energy_insights i JOIN energy_experience_settings x ON x.tenant_id=i.tenant_id
      JOIN energy_settings s ON s.tenant_id=i.tenant_id JOIN solarman_accounts a ON a.tenant_id=i.tenant_id
      JOIN tenants t ON t.id=i.tenant_id LEFT JOIN device_health h ON h.tenant_id=i.tenant_id AND h.account_id=a.id AND h.device=a.device_sn
      WHERE i.tenant_id=$1 AND 'insight:'||i.id::text=$2 AND i.resolved_at IS NULL
      AND(i.snoozed_until IS NULL OR i.snoozed_until<=clock_timestamp())
      AND i.last_seen_at>clock_timestamp()-interval '30 minutes' AND x.insights_enabled AND t.lifecycle='active'
      AND NOT COALESCE(h.auth_fault,false) AND COALESCE(h.device_state,1)=1 AND(h.failed_at IS NULL OR h.succeeded_at>=h.failed_at)
      AND EXISTS(SELECT 1 FROM measurements m WHERE m.tenant_id=i.tenant_id AND m.account_id=a.id AND m.device=a.device_sn
        AND m.observed_at>clock_timestamp()-interval '10 minutes' AND m.observed_at<=clock_timestamp()+interval '30 seconds')`, [job.tenant_id, job.event_key])).rows[0];
    return Boolean(row && energyInstallationBinding(row.current_account, row.device_sn, row.profile) === row.binding);
  }
}
