import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { quarantineEnergyAssistantExpansion } from "../../src/energy-experience-lifecycle.mjs";
import { encryptNotificationSecret } from "../../src/notification-secrets.mjs";
import { openOutageReference, verifyStoredOutageReferences } from "../../src/energy-outage-watch.mjs";
import { nightNativeWindows } from "../../src/energy-native.mjs";

/** @param {object} context @returns {void} */
export function registerEnergyAssistantIntegration({ fixture, fetchApi, password, getBeta }) {
  const input = () => {
    const start = Math.ceil((Date.now() + 15 * 60000) / 900000) * 900000;
    return { startsAt: new Date(start).toISOString(), returnsAt: new Date(start + 24 * 3600000).toISOString(), baselineW: 200 };
  };
  const tools = async f => {
    const response = await fetchApi("/energy/tools", { auth: f.member });
    assert.equal(response.status, 200);
    return response.json();
  };
  const change = (f, body, key = randomUUID(), auth = f.member, csrf = true) => fetchApi("/energy/tools/away", {
    auth, method: "POST", idempotency: key, csrf, body: { currentPassword: password, ...body },
  });
  const channel = async f => {
    const id = randomUUID();
    await f.pool.query("INSERT INTO notification_channels(id,tenant_id,chat_id,secret,language,enabled,verified_at) VALUES($1,$2,'123456',$3,'bg',true,clock_timestamp())", [id, f.target.tenant, encryptNotificationSecret("123456:assistant-fixture-token", f.hub.key, f.target.tenant, id)]);
    return id;
  };

  test("Away previews are private, respect CSRF and compare actual demand scenarios without inverter writes", async () => {
    const f = await fixture();
    try {
      await f.refresh();
      const body = input(), before = f.device.writes.length;
      assert.equal((await fetchApi("/energy/tools/away/preview", { method: "POST", body })).status, 401);
      assert.equal((await fetchApi("/energy/tools/away/preview", { auth: f.member, method: "POST", body, csrf: false })).status, 403);
      const response = await fetchApi("/energy/tools/away/preview", { auth: f.member, method: "POST", body });
      assert.equal(response.status, 200, await response.clone().text());
      const preview = await response.json();
      assert.ok(preview.awayLoadKwh < preview.normalLoadKwh);
      assert.ok(preview.targetAfter <= preview.targetBefore);
      assert.equal(preview.changesInverter, false);
      assert.equal(preview.appliesInHorizon, true);
      assert.equal(f.device.writes.length, before);
      assert.equal((await tools(f)).away.periods.length, 0);
    } finally { await f.dispose(); }
  });

  test("Away saves are password-confirmed, idempotent, tenant-bound and preserve physical and permanent policy settings", async () => {
    const f = await fixture();
    try {
      const data = await tools(f), body = { action: "save", id: randomUUID(), revision: data.away.revision, energyRevision: data.energyRevision, ...input() }, key = randomUUID();
      const original = (await f.pool.query("SELECT revision,profile,automatic,approval_binding,approved_by FROM energy_settings WHERE tenant_id=$1", [f.target.tenant])).rows;
      const writes = f.device.writes.length;
      assert.equal((await change(f, { ...body, currentPassword: "wrong" }, randomUUID())).status, 400);
      assert.equal((await change(f, body, key, f.member, false)).status, 403);
      const response = await change(f, body, key);
      assert.equal(response.status, 200, await response.clone().text());
      assert.equal((await change(f, body, key)).status, 200);
      assert.equal((await change(f, { ...body, baselineW: 300 }, key)).status, 409);
      assert.equal((await tools(f)).away.periods.length, 1);
      assert.equal((await f.pool.query("SELECT normal_model->>'ready' AS ready FROM energy_away_periods WHERE id=$1", [body.id])).rows[0].ready, "true");
      assert.equal((await f.pool.query("SELECT count(*)::int AS n FROM energy_events WHERE tenant_id=$1 AND action='away-save'", [f.target.tenant])).rows[0].n, 1);
      assert.deepEqual((await f.pool.query("SELECT revision,profile,automatic,approval_binding,approved_by FROM energy_settings WHERE tenant_id=$1", [f.target.tenant])).rows, original);
      assert.equal(f.device.writes.length, writes);
      const other = await fetchApi("/energy/tools", { auth: getBeta() });
      assert.equal((await other.json()).away.periods.some(p => p.id === body.id), false);
      const current = await tools(f);
      assert.equal((await change(f, { ...body, id: randomUUID(), revision: current.away.revision })).status, 409);
      assert.equal((await change(f, { action: "cancel", id: body.id, revision: current.away.revision })).status, 200);
      const cancelled = (await tools(f)).away.periods[0];
      assert.equal(cancelled.state, "cancelled");
      assert.ok(cancelled.cancelledAt);
    } finally { await f.dispose(); }
  });

  test("Away changes never replace an active hold and new schedules freeze their occupancy assumptions", async () => {
    const f = await fixture();
    try {
      await f.prepare();
      const before = (await f.pool.query("SELECT state,target_soc,baseline FROM outage_preparations WHERE id=$1", [f.runtime.outage.row.id])).rows;
      const writes = f.device.writes.length;
      const data = await tools(f);
      const body = { action: "save", id: randomUUID(), revision: data.away.revision, energyRevision: data.energyRevision, ...input() };
      assert.equal((await change(f, body)).status, 200);
      assert.deepEqual((await f.pool.query("SELECT state,target_soc,baseline FROM outage_preparations WHERE id=$1", [f.runtime.outage.row.id])).rows, before);
      assert.equal(f.device.writes.length, writes);
      await f.restore();
      const planned = await f.refresh();
      const frozen = (await f.pool.query("SELECT demand FROM energy_plans WHERE id=$1", [planned.plan.id])).rows[0].demand;
      assert.equal(frozen.awayPeriods[0].id, body.id);
      assert.ok(frozen.awayRevision);
    } finally { await f.dispose(); }
  });

  test("quarantining Away mode removes future adjustments while retaining historical absence evidence", async () => {
    const f = await fixture();
    try {
      const data = await tools(f);
      const body = { action: "save", id: randomUUID(), revision: data.away.revision, energyRevision: data.energyRevision, ...input() };
      assert.equal((await change(f, body)).status, 200);
      await quarantineEnergyAssistantExpansion(f.pool, f.target.tenant);
      const current = await tools(f);
      assert.equal(current.away.periods[0].state, "quarantined");
      const profile = (await f.hub.energy.settings(f.target.tenant)).profile;
      const context = await f.hub.energy.experience.away.context(f.runtime, profile);
      assert.equal(context.future.length, 0);
      assert.equal(context.history.length, 0, "a future period was never actually lived away");
    } finally { await f.dispose(); }
  });

  test("Away changes invalidate calculations captured before their revision, and ordinary briefing preferences keep occupancy revision zero", async () => {
    const f = await fixture(), experience = f.hub.energy.experience, original = experience.away.context;
    try {
      await f.refresh();
      assert.equal((await tools(f)).away.revision, "0");
      assert.equal((await f.call("tools/preferences", { revision: "0", briefingsEnabled: false, morningMinute: 435, eveningMinute: 1140, currentPassword: password })).status, 200);
      assert.equal((await tools(f)).away.revision, "0");
      const before = (await f.pool.query("SELECT count(*)::int AS n FROM energy_plans WHERE tenant_id=$1", [f.target.tenant])).rows[0].n;
      experience.away.context = async (...args) => {
        const snapshot = await original.apply(experience.away, args);
        await f.pool.query("UPDATE energy_experience_settings SET away_revision=away_revision+1 WHERE tenant_id=$1", [f.target.tenant]);
        return snapshot;
      };
      const settings = await f.hub.energy.settings(f.target.tenant);
      assert.equal(await f.hub.energy.compute(f.runtime, settings), null);
      assert.equal((await f.pool.query("SELECT count(*)::int AS n FROM energy_plans WHERE tenant_id=$1", [f.target.tenant])).rows[0].n, before);
      const data = await tools(f);
      assert.equal((await change(f, { action: "save", id: randomUUID(), revision: data.away.revision, energyRevision: "999", ...input() })).status, 409);
    } finally { experience.away.context = original; await f.dispose(); }
  });

  test("native night admission accepts legacy occupancy zero and refuses a changed Away revision before a write", async () => {
    const f = await fixture();
    try {
      const result = await f.refresh(), plan = (await f.pool.query("SELECT * FROM energy_plans WHERE id=$1", [result.plan.id])).rows[0];
      const end = new Date(Date.now() + 3600000);
      await f.pool.query("UPDATE energy_settings SET approval_binding=$2,approved_by=$3 WHERE tenant_id=$1", [f.target.tenant, plan.binding, f.target.user]);
      await f.pool.query("UPDATE energy_plans SET state='starting',approved_by=$2,starts_at=clock_timestamp()-interval '1 minute',ends_at=$3,demand=demand-'awayRevision' WHERE id=$1", [plan.id, f.target.user, end]);
      const preparation = { tenant_id: f.target.tenant, energy_plan_id: plan.id, binding: plan.binding, target_soc: plan.prediction.targetSoc, ends_at: end, planned_windows: nightNativeWindows(plan.prediction, plan.profile.timezone) };
      const clock = { fresh: true, passed: true, skewSeconds: 0 };
      await f.hub.energy.authorizeNative(preparation, clock);
      await f.pool.query("INSERT INTO energy_experience_settings(tenant_id) VALUES($1)", [f.target.tenant]);
      await f.hub.energy.authorizeNative(preparation, clock);
      await f.pool.query("UPDATE energy_experience_settings SET away_revision=1 WHERE tenant_id=$1", [f.target.tenant]);
      await assert.rejects(f.hub.energy.authorizeNative(preparation, clock), /Night savings permission or forecast changed/);
      assert.equal(f.device.writes.length, 0);
    } finally { await f.dispose(); }
  });

  test("an account update prevents stale assistant forms from re-enabling preferences, Away dates or an outage watch", async () => {
    const f = await fixture();
    try {
      const data = await tools(f);
      f.hub.accountUpdates.add(f.target.tenant);
      const preference = { revision: data.preferences.revision, briefingsEnabled: false, morningMinute: 435, eveningMinute: 1140, currentPassword: password };
      assert.equal((await f.call("tools/preferences", preference)).status, 409);
      assert.equal((await change(f, { action: "save", id: randomUUID(), revision: data.away.revision, energyRevision: data.energyRevision, ...input() })).status, 409);
      assert.equal((await f.call("tools/outage-watch", { action: "save", revision: "0", consent: true, currentPassword: password, reference: { kind: "area", municipality: "RESTORE", area: "FIXTURE" } })).status, 409);
      assert.equal((await tools(f)).away.periods.length, 0);
      assert.equal((await tools(f)).outageWatch.watch, null);
    } finally { f.hub.accountUpdates.delete(f.target.tenant); await f.dispose(); }
  });

  test("coordinated appliance saves serialize conflicting calculations and replan atomically cancels obsolete reminders", async () => {
    const f = await fixture(), experience = f.hub.energy.experience, calculate = experience.calculate;
    try {
      await f.refresh(); await channel(f);
      const start = Math.ceil((Date.now() + 3600000) / 900000) * 900000;
      const body = { action: "save", revision: "0", name: "Shared-budget appliance", powerKw: 2, durationMinutes: 60, earliestAt: new Date(start).toISOString(), deadlineAt: new Date(start + 4 * 3600000).toISOString(), reminderEnabled: true };
      let entered = 0, release;
      const barrier = new Promise(resolve => { release = resolve; });
      experience.calculate = async function (action, ...args) {
        const result = await calculate.call(this, action, ...args);
        if (action === "load") { entered++; if (entered === 2) release(); await barrier; }
        return result;
      };
      const responses = await Promise.all([f.call("tools/task", { ...body, id: randomUUID() }), f.call("tools/task", { ...body, id: randomUUID() })]);
      assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
      experience.calculate = calculate;
      const data = await tools(f), task = data.tasks[0], id = randomUUID();
      assert.equal((await f.call("tools/task", { ...body, id })).status, 200);
      await f.pool.query("INSERT INTO notification_outbox(id,tenant_id,channel_id,channel_revision,event_key,kind,payload) SELECT $1,$2,id,revision,$3,'energy-reminder',$4 FROM notification_channels WHERE tenant_id=$2 LIMIT 1", [randomUUID(), f.target.tenant, `load:${task.id}:${task.revision}`, { title: "Synthetic reminder", text: "Synthetic reminder", url: "/controls/energy-tools", expiresAt: new Date(Date.now() + 3600000).toISOString() }]);
      const current = await tools(f);
      assert.equal((await f.call("tools/replan", { revision: "999" })).status, 409);
      assert.equal((await f.call("tools/replan", { revision: current.preferences.loadRevision }, randomUUID(), { csrf: false })).status, 403);
      const result = await f.call("tools/replan", { revision: current.preferences.loadRevision });
      assert.equal(result.status, 200, await result.clone().text());
      assert.equal((await result.json()).changed, 2);
      assert.equal((await f.pool.query("SELECT state FROM notification_outbox WHERE tenant_id=$1 AND kind='energy-reminder'", [f.target.tenant])).rows[0].state, "cancelled");
      assert.ok((await tools(f)).tasks.every(item => item.revision === "2"));
      await f.pool.query("UPDATE energy_load_tasks SET reminded_at=clock_timestamp() WHERE id=$1", [task.id]);
      const revised = await tools(f);
      assert.equal((await f.call("tools/replan", { revision: revised.preferences.loadRevision })).status, 200);
      assert.equal((await tools(f)).tasks.find(item => item.id === task.id).revision, "2", "a reminder fixes the previously promised time");
      assert.equal(f.device.writes.length, 0);
    } finally { experience.calculate = calculate; await f.dispose(); }
  });

  test("energy insights require opt-in, persist measured evidence, deduplicate openings and cancel a queued advisory on opt-out", async () => {
    const f = await fixture(), experience = f.hub.energy.experience, notifications = f.hub.notifications;
    const send = notifications.send, platformAt = notifications.platformAt;
    let deliveries = 0;
    f.hub.runtimes.set(f.target.tenant, f.runtime);
    notifications.send = async () => { deliveries++; return { state: "delivered", messageId: 12345 }; };
    notifications.platformAt = Date.now();
    try {
      await f.refresh(); await channel(f);
      assert.equal((await tools(f)).insights.enabled, false);
      await experience.insights.check(f.runtime);
      assert.equal((await tools(f)).insights.checkedAt, null);
      assert.equal((await f.call("tools/preferences", { revision: "0", briefingsEnabled: false, insightsEnabled: true, autoReplan: true, morningMinute: 435, eveningMinute: 1140, currentPassword: password })).status, 200);
      await f.pool.query("DELETE FROM measurements WHERE tenant_id=$1", [f.target.tenant]);
      await f.pool.query("INSERT INTO measurements(tenant_id,account_id,device,observed_at,soc,temperature_c,pv_w,load_w,grid_w,battery_w,ac_enabled,snapshot,sampling_seconds) SELECT $1,$2,$3,clock_timestamp()-(n*interval '5 minutes'),60,15,0,CASE WHEN n<25 THEN 4000 ELSE 1000 END,1000,0,false,'{}',300 FROM generate_series(0,6048)n", [f.target.tenant, f.target.account, f.target.device]);
      await experience.insights.check(f.runtime);
      await experience.insights.check(f.runtime);
      const data = await tools(f);
      assert.equal(data.insights.assessment.consumption.state, "active");
      assert.equal(data.insights.incidents.length, 1);
      const jobs = (await f.pool.query("SELECT * FROM notification_outbox WHERE tenant_id=$1 AND kind='energy-insight'", [f.target.tenant])).rows;
      assert.equal(jobs.length, 1); assert.match(jobs[0].payload.title, /потребление/);
      assert.equal(await experience.insights.current(jobs[0]), true);
      await f.pool.query("INSERT INTO device_health(tenant_id,account_id,device,auth_fault) VALUES($1,$2,$3,true) ON CONFLICT(tenant_id,account_id,device) DO UPDATE SET auth_fault=true", [f.target.tenant, f.target.account, f.target.device]);
      assert.equal(await experience.insights.current(jobs[0]), false, "a connection failure after queueing suppresses the advisory");
      await experience.insights.check(f.runtime);
      assert.equal((await tools(f)).insights.assessment.consumption.state, "stale");
      await f.pool.query("UPDATE device_health SET auth_fault=false WHERE tenant_id=$1", [f.target.tenant]);
      assert.equal((await f.call("tools/insight", { id: data.insights.incidents[0].id, action: "seen" }, randomUUID(), { auth: getBeta() })).status, 404);
      assert.equal((await f.call("tools/insight", { id: data.insights.incidents[0].id, action: "snooze" })).status, 200);
      assert.equal(await experience.insights.current(jobs[0]), false);
      await f.pool.query("UPDATE measurements SET load_w=1000 WHERE tenant_id=$1 AND observed_at>clock_timestamp()-interval '3 hours'", [f.target.tenant]);
      await experience.insights.check(f.runtime);
      assert.ok((await tools(f)).insights.incidents[0].resolvedAt);
      await f.pool.query("UPDATE measurements SET load_w=4000 WHERE tenant_id=$1 AND observed_at>clock_timestamp()-interval '3 hours'", [f.target.tenant]);
      await experience.insights.check(f.runtime);
      assert.equal((await f.pool.query("SELECT count(*)::int AS n FROM notification_outbox WHERE tenant_id=$1 AND kind='energy-insight'", [f.target.tenant])).rows[0].n, 1, "a new episode within 24 hours must not create a second opening");
      const current = await tools(f);
      assert.equal((await f.call("tools/preferences", { revision: current.preferences.revision, briefingsEnabled: false, insightsEnabled: false, autoReplan: false, morningMinute: 435, eveningMinute: 1140, currentPassword: password })).status, 200);
      await notifications.runOnce();
      assert.equal(deliveries, 0);
      await experience.tick();
      await Promise.allSettled([...experience.pending.values()]);
      assert.equal(f.device.writes.length, 0);
    } finally { notifications.send = send; notifications.platformAt = platformAt; f.hub.runtimes.delete(f.target.tenant); await f.dispose(); }
  });

  test("outage watches protect private references, require consent, isolate notices and fail closed when the provider is unavailable", async () => {
    const f = await fixture(), experience = f.hub.energy.experience, provider = experience.outageWatch.provider;
    const getNotices = provider.notices;
    f.hub.runtimes.set(f.target.tenant, f.runtime);
    try {
      await channel(f);
      const point = "32Z0000000000000", body = { action: "save", revision: "0", currentPassword: password, consent: true, reference: { kind: "supply-point", point } };
      assert.equal((await f.call("tools/outage-watch", { ...body, consent: false })).status, 400);
      assert.equal((await f.call("tools/outage-watch", body, randomUUID(), { csrf: false })).status, 403);
      assert.equal((await f.call("tools/outage-watch", { ...body, currentPassword: "wrong" })).status, 400);
      const saved = await f.call("tools/outage-watch", body);
      assert.equal(saved.status, 200, await saved.clone().text());
      const row = (await f.pool.query("SELECT * FROM energy_outage_watches WHERE tenant_id=$1", [f.target.tenant])).rows[0];
      assert.equal(JSON.stringify(row.secret).includes(point), false);
      assert.equal(openOutageReference(row, f.hub.key).point, point);
      assert.throws(() => openOutageReference({ ...row, tenant_id: randomUUID() }, f.hub.key));
      await verifyStoredOutageReferences(f.pool, f.hub.key);
      const start = Date.now() + 4 * 3600000;
      provider.notices = async reference => {
        assert.equal(reference.point, point);
        return [{ key: "fixture-source", startsAt: new Date(start).toISOString(), endsAt: new Date(start + 3600000).toISOString(), scope: "supply-point", detail: "Synthetic integration notice" }];
      };
      await experience.outageWatch.check(f.runtime, true);
      const current = await tools(f), notice = current.outageWatch.notices[0];
      assert.ok(notice); assert.equal(current.outageWatch.watch.hint, "…0000");
      assert.equal((await tools(f)).outageWatch.watch.code, "ready");
      assert.equal((await fetchApi(`/energy/tools/outage-notices/${notice.id}`, { auth: f.member })).status, 200);
      assert.equal((await fetchApi(`/energy/tools/outage-notices/${notice.id}`, { auth: getBeta() })).status, 409);
      const exported = await fetchApi("/workspace/archive", { auth: f.member, method: "POST", body: { currentPassword: password } });
      assert.equal(exported.status, 200);
      const archive = await exported.text();
      assert.equal(archive.includes(point), false); assert.ok(archive.includes("Synthetic integration notice"));
      await f.pool.query("UPDATE energy_outage_watches SET attempted_at=null WHERE tenant_id=$1", [f.target.tenant]);
      await experience.outageWatch.check(f.runtime, true);
      assert.equal((await f.pool.query("SELECT count(*)::int AS n FROM notification_outbox WHERE tenant_id=$1 AND kind='outage-notice'", [f.target.tenant])).rows[0].n, 1);
      provider.notices = async () => { throw new Error("Provider offline"); };
      await f.pool.query("UPDATE energy_outage_watches SET attempted_at=null WHERE tenant_id=$1", [f.target.tenant]);
      assert.equal((await experience.outageWatch.check(f.runtime, true)).accepted, false);
      assert.equal((await tools(f)).outageWatch.watch.code, "utility-unavailable");
      assert.equal((await fetchApi(`/energy/tools/outage-notices/${notice.id}`, { auth: f.member })).status, 409);
      await quarantineEnergyAssistantExpansion(f.pool, f.target.tenant);
      assert.equal((await tools(f)).outageWatch.watch.enabled, false);
      assert.equal((await tools(f)).outageWatch.notices.length, 0);
      assert.equal(f.device.writes.length, 0);
    } finally { provider.notices = getNotices; f.hub.runtimes.delete(f.target.tenant); await f.dispose(); }
  });
}
