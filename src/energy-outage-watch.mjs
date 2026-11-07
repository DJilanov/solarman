import { randomUUID } from "node:crypto";
import { SecurityError } from "./account-security.mjs";
import { sealSecret, openSecret } from "./stored-secret.mjs";
import { requireActiveTenant } from "./tenant-lifecycle.mjs";
import { EnergyUtility } from "./energy-utility.mjs";
import { validateUtilityReference, UTILITY_SOURCE } from "./energy-utility-model.mjs";
import { energyLocalTime } from "./energy-time.mjs";

/** @param {object} row @param {Buffer} key @returns {object} */
export function openOutageReference(row, key) {
  try { return validateUtilityReference(openSecret(row.secret, key, `solarman-outage:${row.tenant_id}:${row.id}:v1`)); }
  catch { throw new Error("The outage reference could not be decrypted"); }
}

/** @param {import('pg').Pool|import('pg').PoolClient} client @param {Buffer} key @returns {Promise<number>} */
export async function verifyStoredOutageReferences(client, key) {
  if (!(await client.query("SELECT to_regclass('public.energy_outage_watches') IS NOT NULL AS present")).rows[0].present) return 0;
  const rows = (await client.query("SELECT id,tenant_id,secret,enabled FROM energy_outage_watches WHERE secret IS NOT NULL OR enabled")).rows;
  for (const row of rows) openOutageReference(row, key);
  return rows.length;
}

export class EnergyOutageWatch {
  /** @param {object} experience */
  constructor(experience) { this.experience = experience; this.pool = experience.pool; this.hub = experience.hub; this.provider = new EnergyUtility(experience); }

  /** @param {object} runtime @returns {Promise<object>} */
  async status(runtime) {
    const [watch, notices] = await Promise.all([
      this.pool.query("SELECT id,revision::text,reference_kind AS kind,reference_hint AS hint,enabled,quarantined,checked_at AS \"checkedAt\",attempted_at AS \"attemptedAt\",last_code AS code FROM energy_outage_watches WHERE tenant_id=$1", [runtime.tenantId]),
      this.pool.query("SELECT n.id,n.starts_at AS \"startsAt\",n.ends_at AS \"endsAt\",n.detail,n.scope,n.source_url AS \"sourceUrl\",n.fetched_at AS \"fetchedAt\",n.seen_at AS \"seenAt\" FROM energy_outage_notices n JOIN energy_outage_watches w ON w.id=n.watch_id WHERE n.tenant_id=$1 AND w.enabled AND NOT w.quarantined AND w.account_id=$2 AND w.device=$3 AND n.withdrawn_at IS NULL AND n.ends_at>clock_timestamp() ORDER BY n.starts_at,n.id LIMIT 30", [runtime.tenantId, runtime.account?.id ?? null, runtime.device ?? ""]),
    ]);
    return { watch: watch.rows[0] ?? null, notices: notices.rows, sourceUrl: UTILITY_SOURCE };
  }

  /** @param {object} session @param {object} runtime @param {object} body @returns {Promise<object>} */
  async change(session, runtime, body) {
    if (!["save", "disable"].includes(body.action) || typeof body.revision !== "string" || !/^\d{1,18}$/.test(body.revision)) throw new SecurityError(400, "Refresh the outage watch before saving");
    let reference;
    if (body.action === "save") {
      try { reference = validateUtilityReference(body.reference); }
      catch (error) { throw new SecurityError(400, error.message); }
      if (body.consent !== true) throw new SecurityError(400, "Confirm read-only checks with ERM Zapad before enabling this watch");
    }
    const hash = await this.experience.security.confirmedPassword(session.id, body.currentPassword);
    await this.experience.security.withUser(session.id, async (client, user) => {
      await this.experience.security.activeSession(client, session);
      if (user.tenant_id !== runtime.tenantId || user.password_hash !== hash) throw new SecurityError(409, "Your account changed. Refresh this page and try again.");
      await client.query("SELECT id FROM tenants WHERE id=$1 FOR UPDATE", [runtime.tenantId]);
      await requireActiveTenant(client, runtime.tenantId);
      if (this.hub.accountUpdates.has(runtime.tenantId)) throw new SecurityError(409, "An account update is already in progress");
      const current = (await client.query("SELECT * FROM energy_outage_watches WHERE tenant_id=$1 FOR UPDATE", [runtime.tenantId])).rows[0];
      if (String(current?.revision ?? 0) !== body.revision) throw new SecurityError(409, "The outage watch changed. Refresh before saving");
      await this.experience.cancelMessages(client, runtime.tenantId, "outage-notice");
      if (reference) {
        const account = (await client.query("SELECT id,device_sn FROM solarman_accounts WHERE tenant_id=$1", [runtime.tenantId])).rows[0];
        if (!account || account.id !== runtime.account?.id || account.device_sn !== runtime.device || !runtime.device) throw new SecurityError(409, "Select an inverter before enabling an outage watch");
        const id = current?.id ?? randomUUID(), hint = reference.kind === "area" ? `${reference.municipality} · ${reference.area}`.slice(0, 80) : `…${reference.point.slice(-4)}`;
        const secret = sealSecret(reference, this.hub.key, `solarman-outage:${runtime.tenantId}:${id}:v1`);
        await client.query("INSERT INTO energy_outage_watches(id,tenant_id,account_id,device,reference_kind,reference_hint,secret,enabled) VALUES($1,$2,$3,$4,$5,$6,$7,true) ON CONFLICT(tenant_id) DO UPDATE SET account_id=$3,device=$4,reference_kind=$5,reference_hint=$6,secret=$7,enabled=true,quarantined=false,revision=energy_outage_watches.revision+1,checked_at=null,attempted_at=null,last_code=null,updated_at=clock_timestamp()", [id, runtime.tenantId, account.id, account.device_sn, reference.kind, hint, secret]);
        await client.query("UPDATE energy_outage_notices SET withdrawn_at=clock_timestamp() WHERE tenant_id=$1 AND withdrawn_at IS NULL", [runtime.tenantId]);
      } else if (current) {
        await client.query("UPDATE energy_outage_watches SET enabled=false,secret=null,revision=revision+1,updated_at=clock_timestamp() WHERE tenant_id=$1", [runtime.tenantId]);
      }
    });
    return this.status(runtime);
  }

  /** @param {object} runtime @param {boolean} [manual] @returns {Promise<object>} */
  async check(runtime, manual = false) {
    const watch = (await this.pool.query("UPDATE energy_outage_watches w SET attempted_at=clock_timestamp() FROM tenants t,solarman_accounts a WHERE w.tenant_id=$1 AND t.id=w.tenant_id AND t.lifecycle='active' AND a.tenant_id=t.id AND a.id=w.account_id AND a.device_sn=w.device AND w.enabled AND NOT w.quarantined AND(w.attempted_at IS NULL OR w.attempted_at<clock_timestamp()-$2::interval) RETURNING w.*", [runtime.tenantId, manual ? "5 minutes" : "3 hours"])).rows[0];
    if (!watch) return { accepted: false, reason: "cooldown-or-disabled" };
    try {
      const reference = openOutageReference(watch, this.hub.key), now = Date.now();
      const notices = (await this.provider.notices(reference)).filter(notice => Date.parse(notice.endsAt) > now && Date.parse(notice.startsAt) <= now + 7 * 86400000);
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT id FROM tenants WHERE id=$1 FOR UPDATE", [runtime.tenantId]);
        await requireActiveTenant(client, runtime.tenantId);
        if (this.hub.accountUpdates.has(runtime.tenantId)) { await client.query("ROLLBACK"); return { accepted: false }; }
        const current = (await client.query("SELECT w.* FROM energy_outage_watches w JOIN solarman_accounts a ON a.tenant_id=w.tenant_id AND a.id=w.account_id AND a.device_sn=w.device WHERE w.tenant_id=$1 AND w.id=$2 AND w.revision=$3 AND w.enabled AND NOT w.quarantined FOR UPDATE OF w", [runtime.tenantId, watch.id, watch.revision])).rows[0];
        if (!current) { await client.query("ROLLBACK"); return { accepted: false }; }
        for (const notice of notices) await client.query("INSERT INTO energy_outage_notices(id,tenant_id,watch_id,source_key,starts_at,ends_at,detail,scope,source_url,fetched_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,clock_timestamp()) ON CONFLICT(watch_id,source_key) DO UPDATE SET detail=$7,withdrawn_at=null,fetched_at=clock_timestamp()", [randomUUID(), runtime.tenantId, watch.id, notice.key, notice.startsAt, notice.endsAt, notice.detail, notice.scope, UTILITY_SOURCE]);
        await client.query("UPDATE energy_outage_notices SET withdrawn_at=clock_timestamp() WHERE watch_id=$1 AND withdrawn_at IS NULL AND NOT(source_key=ANY($2::text[]))", [watch.id, notices.map(notice => notice.key)]);
        const unseen = (await client.query("SELECT id FROM energy_outage_notices WHERE watch_id=$1 AND withdrawn_at IS NULL AND notified_at IS NULL AND ends_at>clock_timestamp()", [watch.id])).rowCount;
        if (unseen) {
          const day = energyLocalTime(now, runtime.timezone).day;
          const channels = await this.experience.enqueue(client, runtime.tenantId, `outage:${watch.id}:${day}`, "outage-notice", language => ({
            title: language === "bg" ? "Публикувано е планирано прекъсване" : "A planned outage has been published",
            text: language === "bg" ? "Проверете дали обектът Ви е засегнат и прегледайте подготовката в енергийния асистент." : "Confirm whether your property is affected and review preparation in the energy assistant.", watchRevision: String(watch.revision),
          }), Math.min(...notices.map(notice => Date.parse(notice.endsAt)), now + 6 * 3600000));
          if (channels) await client.query("UPDATE energy_outage_notices SET notified_at=clock_timestamp() WHERE watch_id=$1 AND withdrawn_at IS NULL AND notified_at IS NULL", [watch.id]);
        }
        await client.query("UPDATE energy_outage_watches SET checked_at=clock_timestamp(),last_code='ready' WHERE id=$1", [watch.id]);
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
      return { accepted: true };
    } catch (error) {
      const code = ["utility-capacity", "utility-format", "utility-no-publication", "utility-ambiguous-time", "utility-too-large"].includes(error?.message) ? error.message : "utility-unavailable";
      await this.pool.query("UPDATE energy_outage_watches SET last_code=$4 WHERE tenant_id=$1 AND id=$2 AND revision=$3", [runtime.tenantId, watch.id, watch.revision, code]);
      return { accepted: false, reason: code };
    }
  }

  /** @param {object} runtime @param {string} id @returns {Promise<object>} */
  async notice(runtime, id) {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)) throw new SecurityError(404, "Outage notice not found");
    const state = await this.status(runtime), notice = state.notices.find(item => item.id === id);
    if (!notice || state.watch?.code !== "ready" || Date.now() - new Date(state.watch.checkedAt).getTime() > 6 * 3600000) throw new SecurityError(409, "Refresh the outage watch before preparing for this notice");
    return notice;
  }

  /** @param {object} job @returns {Promise<boolean>} */
  async current(job) {
    return Boolean((await this.pool.query("SELECT 1 FROM energy_outage_watches w JOIN solarman_accounts a ON a.tenant_id=w.tenant_id AND a.id=w.account_id AND a.device_sn=w.device JOIN tenants t ON t.id=w.tenant_id WHERE w.tenant_id=$1 AND w.enabled AND NOT w.quarantined AND w.revision::text=$3 AND w.last_code='ready' AND w.checked_at>clock_timestamp()-interval '6 hours' AND t.lifecycle='active' AND $2 LIKE 'outage:'||w.id::text||':%' AND EXISTS(SELECT 1 FROM energy_outage_notices n WHERE n.watch_id=w.id AND n.withdrawn_at IS NULL AND n.ends_at>clock_timestamp())", [job.tenant_id, job.event_key, job.payload.watchRevision ?? ""])).rowCount);
  }
}
