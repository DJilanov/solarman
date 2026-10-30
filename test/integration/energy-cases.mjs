import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { energyProfile, energyWeather } from "../fixtures/energy.mjs";
import {
  commissioningBinding,
  currentCommissioning,
} from "../../src/commissioning-state.mjs";
import { quarantineEnergy } from "../../src/energy-lifecycle.mjs";
import { nightNativeWindows } from "../../src/energy-native.mjs";
import { energySiteHash } from "../../src/energy-profile.mjs";
import { encryptCredentials } from "../../src/credentials.mjs";
import { encryptNotificationSecret } from "../../src/notification-secrets.mjs";
import { quarantineEnergyExperience } from "../../src/energy-experience-lifecycle.mjs";

/** @param {object} context @returns {void} */
export function registerEnergyIntegration({
  getPool,
  getHub,
  outageFixture,
  fetchApi,
  password,
  getBeta,
}) {
  async function fixture() {
    const f = await outageFixture(),
      pool = getPool(),
      hub = getHub(),
      weather = hub.energy.weather;
    hub.energy.weather = {
      available: () => true,
      fetch: async () => energyWeather(),
    };
    f.runtime.hub.energy = hub.energy;
    const state = async () => {
      const response = await fetchApi("/energy", { auth: f.member });
      assert.equal(response.status, 200, await response.clone().text());
      return response.json();
    };
    const call = (
      action,
      body = {},
      idempotency = randomUUID(),
      options = {},
    ) =>
      fetchApi(`/energy/${action}`, {
        auth: f.member,
        method: "POST",
        body,
        idempotency,
        ...options,
      });
    const initial = await state(),
      profile = energyProfile();
    const saved = await call("settings", {
      revision: initial.revision,
      profile,
    });
    assert.equal(saved.status, 202, await saved.clone().text());
    const now = Date.now();
    await pool.query(
      "INSERT INTO measurements(tenant_id,account_id,device,observed_at,soc,temperature_c,pv_w,load_w,grid_w,battery_w,ac_enabled,snapshot,sampling_seconds) SELECT $1,$2,$3,$4::timestamptz-(n*interval '5 minutes'),60,15,0,1000,1000,0,false,'{}',300 FROM generate_series(0,288)n ON CONFLICT DO NOTHING",
      [f.target.tenant, f.target.account, f.target.device, new Date(now)],
    );
    const refresh = async () => {
      const value = await state();
      await pool.query(
        "UPDATE energy_settings SET attempted_at=null WHERE tenant_id=$1",
        [f.target.tenant],
      );
      const result = await call("refresh", { revision: value.revision });
      assert.equal(result.status, 202, await result.clone().text());
      await hub.energy.pending.get(f.target.tenant);
      return state();
    };
    const approve = async () => {
      await f.prepare();
      await f.restore();
      const proof = {
        targetSoc: 80,
        appliedAt: new Date(now - 180000).toISOString(),
        gridChargingObservedAt: new Date(now - 120000).toISOString(),
        targetHoldObservedAt: new Date(now - 60000).toISOString(),
        holdObservedAt: new Date(now - 60000).toISOString(),
        restoredAt: new Date(now).toISOString(),
        applyWritesVerified: true,
        restoreWritesVerified: true,
        backupSettingsPreserved: true,
      };
      await pool.query(
        "UPDATE outage_preparations SET proof=$2,approved_at=clock_timestamp() WHERE id=$1",
        [f.runtime.outage.row.id, proof],
      );
      await pool.query(
        "UPDATE control_commissioning SET state='approved',attended_until=null WHERE tenant_id=$1 AND state='attending'",
        [f.target.tenant],
      );
      f.runtime.commissioning = await currentCommissioning(
        pool,
        f.target.tenant,
      );
      await f.runtime.mapProvider(await f.runtime.readProvider());
      await f.runtime.outage.load();
      assert.equal(
        f.runtime.outage.status().canPrepare,
        true,
        JSON.stringify(f.runtime.readiness()),
      );
    };
    const dispose = async () => {
      await hub.energy.pending.get(f.target.tenant);
      await f.runtime.outage.load();
      if (f.runtime.outage.active)
        await f.runtime.queue(() => f.runtime.outage.stop(), 10);
      await pool.query(
        "UPDATE energy_plans SET state='cancelled',code='fixture-cleanup' WHERE tenant_id=$1 AND state IN('scheduled','starting','running','restoring')",
        [f.target.tenant],
      );
      hub.energy.weather = weather;
      await f.dispose();
    };
    return { ...f, pool, hub, state, call, refresh, approve, dispose };
  }
  test("energy tools calculate outages and keep appliance plans tenant-bound, revisioned and free of inverter writes", async () => {
    const f = await fixture();
    try {
      assert.equal((await fetchApi("/energy/tools")).status, 401);
      const initial = await (await fetchApi("/energy/tools", { auth: f.member })).json();
      assert.equal(initial.ready, true);
      assert.equal(initial.report.days.length, 7);
      assert.equal(initial.tasks.length, 0);
      const outage = await f.call("tools/outage", { startsAt: new Date(Date.now() + 4 * 3600000).toISOString(), hours: 10, mode: "essential", essentialW: 500 });
      assert.equal(outage.status, 200, await outage.clone().text());
      assert.equal((await outage.json()).feasible, true);
      assert.equal((await f.call("tools/outage", { startsAt: "invalid", hours: 10, mode: "essential", essentialW: 500 })).status, 400);
      await f.refresh();
      const body = { action: "save", id: randomUUID(), revision: "0", name: "Heater", powerKw: 1,
        durationMinutes: 30, earliestAt: new Date(Date.now() + 15 * 60000).toISOString(), deadlineAt: new Date(Date.now() + 4 * 3600000).toISOString(), reminderEnabled: false };
      assert.equal((await f.call("tools/task", body, randomUUID(), { csrf: false })).status, 403);
      const saved = await f.call("tools/task", body);
      assert.equal(saved.status, 200, await saved.clone().text());
      assert.equal((await f.call("tools/task", body)).status, 200);
      const own = await (await fetchApi("/energy/tools", { auth: f.member })).json();
      assert.equal(own.tasks.length, 1);
      assert.equal(own.tasks[0].currentBinding, true);
      const other = await (await fetchApi("/energy/tools", { auth: getBeta() })).json();
      assert.equal(other.tasks.some(task => task.id === body.id), false);
      assert.equal((await f.call("tools/task", { action: "cancel", id: body.id, revision: "1" }, randomUUID(), { auth: getBeta() })).status, 404);
      assert.equal((await f.call("tools/task", { action: "done", id: body.id, revision: "1" })).status, 200);
      assert.equal((await f.call("tools/task", { action: "cancel", id: body.id, revision: "1" })).status, 409);
      assert.equal((await f.pool.query("SELECT state FROM energy_load_tasks WHERE id=$1", [body.id])).rows[0].state, "done");
      assert.equal(f.device.writes.length, 0);
    } finally { await f.dispose(); }
  });

  test("energy briefings deduplicate, expire honestly, deliver manual appliance reminders and quarantine on restore", async () => {
    const f = await fixture(), notifications = f.hub.notifications;
    const send = notifications.send, platformAt = notifications.platformAt;
    let deliveries = 0;
    notifications.send = async () => { deliveries++; return { state: "delivered", messageId: 12345 }; };
    notifications.platformAt = Date.now();
    f.hub.runtimes.set(f.target.tenant, f.runtime);
    try {
      const body = { revision: "0", briefingsEnabled: true, morningMinute: 435, eveningMinute: 1140, currentPassword: password };
      assert.equal((await f.call("tools/preferences", body)).status, 409);
      const channelId = randomUUID();
      await f.pool.query("INSERT INTO notification_channels(id,tenant_id,chat_id,secret,language,enabled,verified_at) VALUES($1,$2,'123456',$3,'bg',true,clock_timestamp())", [channelId, f.target.tenant, encryptNotificationSecret("123456:energy-fixture-token", f.hub.key, f.target.tenant, channelId)]);
      assert.equal((await f.call("tools/preferences", { ...body, currentPassword: "wrong-password" })).status, 400);
      assert.equal((await f.call("tools/preferences", body, randomUUID(), { csrf: false })).status, 403);
      assert.equal((await f.call("tools/preferences", body)).status, 200);
      const preferences = await f.hub.energy.experience.preferences(f.target.tenant);
      const preference = { tenant_id: f.target.tenant, revision: preferences.revision, timezone: f.runtime.timezone };
      await f.hub.energy.experience.sendBriefing(preference, "morning");
      await f.hub.energy.experience.sendBriefing(preference, "morning");
      const notices = (await f.pool.query("SELECT * FROM notification_outbox WHERE tenant_id=$1 AND kind='energy-briefing'", [f.target.tenant])).rows;
      assert.equal(notices.length, 1);
      assert.match(notices[0].payload.title, /Сутрешен/);
      await f.pool.query("UPDATE notification_outbox SET next_attempt_at='1970-01-01',payload=jsonb_set(payload,'{expiresAt}',to_jsonb((clock_timestamp()-interval '1 minute')::text)) WHERE id=$1", [notices[0].id]);
      await notifications.runOnce();
      assert.equal((await f.pool.query("SELECT state FROM notification_outbox WHERE id=$1", [notices[0].id])).rows[0].state, "failed");
      assert.equal(deliveries, 0);
      await f.refresh();
      const taskId = randomUUID(), task = { action: "save", id: taskId, revision: "0", name: "Dishwasher", powerKw: 1, durationMinutes: 60,
        earliestAt: new Date(Date.now() + 60000).toISOString(), deadlineAt: new Date(Date.now() + 4 * 3600000).toISOString(), reminderEnabled: true };
      assert.equal((await f.call("tools/task", task)).status, 200);
      await f.pool.query("UPDATE energy_load_tasks SET suggested_at=clock_timestamp()-interval '1 second' WHERE id=$1", [taskId]);
      await f.hub.energy.experience.remind({ id: taskId, tenant_id: f.target.tenant, revision: "1" });
      await f.hub.energy.experience.remind({ id: taskId, tenant_id: f.target.tenant, revision: "1" });
      const reminder = (await f.pool.query("SELECT id,payload FROM notification_outbox WHERE tenant_id=$1 AND kind='energy-reminder'", [f.target.tenant])).rows;
      assert.equal(reminder.length, 1);
      assert.match(reminder[0].payload.text, /Dishwasher/);
      await f.pool.query("UPDATE notification_outbox SET next_attempt_at='1970-01-01' WHERE id=$1", [reminder[0].id]);
      await notifications.runOnce();
      assert.equal(deliveries, 1);
      assert.equal((await f.pool.query("SELECT state FROM notification_outbox WHERE id=$1", [reminder[0].id])).rows[0].state, "delivered");
      const staleId = randomUUID();
      assert.equal((await f.call("tools/task", { ...task, id: staleId })).status, 200);
      await f.pool.query("UPDATE energy_load_tasks SET suggested_at=clock_timestamp()-interval '1 second' WHERE id=$1", [staleId]);
      await f.hub.energy.experience.remind({ id: staleId, tenant_id: f.target.tenant, revision: "1" });
      await f.pool.query("UPDATE energy_load_tasks SET binding='changed-installation' WHERE id=$1", [staleId]);
      const staleNotice = (await f.pool.query("UPDATE notification_outbox SET next_attempt_at='1970-01-01' WHERE tenant_id=$1 AND event_key=$2 RETURNING id", [f.target.tenant, `load:${staleId}:1`])).rows[0];
      await notifications.runOnce();
      assert.equal(deliveries, 1, "an installation change must invalidate a queued appliance reminder");
      assert.equal((await f.pool.query("SELECT state FROM notification_outbox WHERE id=$1", [staleNotice.id])).rows[0].state, "cancelled");
      await quarantineEnergyExperience(f.pool, f.target.tenant);
      assert.equal((await f.hub.energy.experience.preferences(f.target.tenant)).briefingsEnabled, false);
      assert.equal((await f.pool.query("SELECT reminder_enabled FROM energy_load_tasks WHERE id=$1", [taskId])).rows[0].reminder_enabled, false);
      assert.equal(f.device.writes.length, 0);
    } finally {
      notifications.send = send; notifications.platformAt = platformAt;
      f.hub.runtimes.delete(f.target.tenant);
      await f.pool.query("UPDATE notification_outbox SET state='cancelled',completed_at=clock_timestamp() WHERE tenant_id=$1 AND state IN('queued','retry','sending')", [f.target.tenant]);
      await f.pool.query("UPDATE energy_experience_settings SET briefings_enabled=false WHERE tenant_id=$1", [f.target.tenant]);
      await f.dispose();
    }
  });

  test("energy settings enforce authentication, CSRF, tenant isolation, revision and idempotency", async () => {
    const f = await fixture();
    try {
      assert.equal((await fetchApi("/energy")).status, 401);
      const value = await f.state(),
        body = { revision: value.revision, profile: energyProfile() },
        key = randomUUID();
      assert.equal(
        (await f.call("settings", body, key, { csrf: false })).status,
        403,
      );
      assert.equal(
        (
          await f.call("settings", {
            ...body,
            profile: { ...body.profile, unexpected: true },
          })
        ).status,
        400,
      );
      const both = await Promise.all([
        f.call("settings", body, key),
        f.call("settings", body, key),
      ]);
      assert.deepEqual(
        both.map((result) => result.status),
        [202, 202],
      );
      assert.equal(
        (
          await f.call(
            "settings",
            { ...body, profile: { ...body.profile, timezone: "UTC" } },
            key,
          )
        ).status,
        409,
      );
      assert.equal((await f.call("settings", body)).status, 409);
      const beta = await (
        await fetchApi("/energy", { auth: getBeta() })
      ).json();
      assert.equal(beta.revision, "0");
      assert.equal(beta.plan, null);
      assert.equal(beta.profile.battery.capacityKwh, null);
      assert.equal(f.device.writes.length, 0);
    } finally {
      await f.dispose();
    }
  });
  test("energy forecast jobs persist immutable inputs and cache weather without inverter writes", async () => {
    const f = await fixture();
    try {
      let fetches = 0;
      f.hub.energy.weather.fetch = async () => {
        fetches++;
        return energyWeather();
      };
      const value = await f.refresh();
      assert.equal(value.code, "ready");
      assert.equal(value.plan.prediction.action, "charge-and-hold");
      assert.equal(value.plan.demandQuality, "limited");
      assert.ok(value.plan.demandCoveredHours >= 23);
      assert.equal(value.plan.forecast.provider, "fixture");
      assert.equal(value.plan.prediction.assumptions.initialDischarging, false);
      assert.equal(value.plan.prediction.assumptions.dischargeRestartMarginSoc, 6);
      const original = value.plan.id,
        frozen = JSON.stringify(value.plan.prediction);
      const again = await f.refresh();
      assert.notEqual(again.plan.id, original);
      assert.equal(fetches, 1);
      assert.equal(
        JSON.stringify(
          (
            await f.pool.query(
              "SELECT prediction FROM energy_plans WHERE id=$1",
              [original],
            )
          ).rows[0].prediction,
        ),
        frozen,
      );
      assert.equal(
        (await f.call("refresh", { revision: again.revision })).status,
        429,
      );
      assert.equal(f.device.writes.length, 0);
      assert.equal(
        (
          await f.call("apply", {
            revision: again.revision,
            planId: again.plan.id,
            choice: "tonight",
            currentPassword: password,
          })
        ).status,
        409,
      );
      const beta = await f.call(
        "adjust",
        { revision: again.revision, planId: again.plan.id, targetSoc: 90 },
        randomUUID(),
        { auth: getBeta() },
      );
      assert.equal(beta.status, 409);
    } finally {
      await f.dispose();
    }
  });
  test("a refreshed preview does not replace an approved night plan or its target", async () => {
    const f = await fixture();
    try {
      await f.approve();
      const writes = f.device.writes.length;
      const initial = await f.refresh();
      assert.equal(
        (
          await f.call("apply", {
            revision: initial.revision,
            planId: initial.plan.id,
            choice: "tonight",
            currentPassword: password,
          })
        ).status,
        202,
      );
      const saved = await f.state(),
        id = saved.plan.id;
      const frozen = JSON.stringify(saved.plan.prediction);
      const updated = await f.refresh();
      assert.equal(updated.plan.id, id);
      assert.equal(updated.plan.state, "scheduled");
      assert.equal(JSON.stringify(updated.plan.prediction), frozen);
      assert.ok(updated.preview);
      assert.notEqual(updated.preview.id, id);
      assert.equal(updated.preview.state, "recommended");
      assert.equal(updated.preview.startsAt, updated.plan.startsAt);
      assert.equal(updated.preview.settingsRevision, updated.revision);
      assert.equal(f.device.writes.length, writes);
      await f.pool.query(
        "UPDATE energy_plans SET settings_revision=settings_revision+1 WHERE id=$1",
        [updated.preview.id],
      );
      assert.equal(
        (await f.state()).preview,
        null,
        "a preview from different settings must not be paired with the saved plan",
      );
    } finally {
      await f.dispose();
    }
  });

  test("energy planning preserves the last forecast on provider failure and refuses stale telemetry", async () => {
    const f = await fixture();
    try {
      const original = await f.refresh();
      await f.pool.query(
        "UPDATE energy_forecasts SET expires_at=clock_timestamp()-interval '1 minute' WHERE tenant_id=$1",
        [f.target.tenant],
      );
      f.hub.energy.weather.fetch = async () => {
        throw new Error("fixture provider unavailable");
      };
      const failed = await f.refresh();
      assert.equal(failed.code, "calculation-unavailable");
      assert.equal(failed.plan.id, original.plan.id);
      assert.ok(failed.plan.forecast.slots.length);
      await f.pool.query(
        "DELETE FROM measurements WHERE tenant_id=$1 AND observed_at>clock_timestamp()-interval '1 hour'",
        [f.target.tenant],
      );
      const stale = await f.refresh();
      assert.equal(stale.code, "readings-stale");
      assert.equal(f.device.writes.length, 0);
    } finally {
      await f.dispose();
    }
  });
  test("energy planning uses measured discharge and refuses recommendations from an older battery model", async () => {
    const f = await fixture();
    try {
      await f.approve();
      await f.pool.query(
        "UPDATE measurements SET battery_w=500 WHERE tenant_id=$1 AND observed_at=(SELECT max(observed_at) FROM measurements WHERE tenant_id=$1)",
        [f.target.tenant],
      );
      const value = await f.refresh();
      assert.equal(value.plan.prediction.assumptions.initialDischarging, true);
      assert.equal(value.control.canActivate, true);
      const writes = f.device.writes.length;
      await f.pool.query(
        "UPDATE energy_plans SET prediction=jsonb_set(prediction,'{version}',to_jsonb($2::text)) WHERE id=$1",
        [value.plan.id, "hourly-pv/load/tariff-battery/v1"],
      );
      const rejected = await f.call("apply", {
        revision: value.revision,
        planId: value.plan.id,
        choice: "automatic",
        currentPassword: password,
      });
      assert.equal(rejected.status, 409);
      assert.match((await rejected.json()).error, /current plan/);
      const current = await f.state();
      assert.equal(current.automatic, false);
      assert.equal(current.plan.state, "recommended");
      assert.equal(f.device.writes.length, writes);
    } finally {
      await f.dispose();
    }
  });
  test("energy night opt-in requires password and matching controls; pause is durable and idempotent", async () => {
    const f = await fixture();
    try {
      await f.approve();
      const value = await f.refresh(),
        body = {
          revision: value.revision,
          planId: value.plan.id,
          choice: "automatic",
          currentPassword: password,
        };
      assert.equal(value.control.canActivate, true);
      assert.equal(
        (await f.call("apply", { ...body, currentPassword: "incorrect" }))
          .status,
        400,
      );
      const key = randomUUID();
      const applied = await f.call("apply", body, key);
      assert.equal(applied.status, 202, await applied.clone().text());
      assert.equal((await f.call("apply", body, key)).status, 202);
      let current = await f.state();
      assert.equal(current.automatic, true);
      assert.equal(current.plan.state, "scheduled");
      const pauseKey = randomUUID();
      assert.equal(
        (await f.call("pause", { revision: current.revision }, pauseKey))
          .status,
        202,
      );
      assert.equal(
        (await f.call("pause", { revision: current.revision }, pauseKey))
          .status,
        202,
      );
      current = await f.state();
      assert.equal(current.automatic, false);
      assert.equal(current.plan.state, "cancelled");
      await f.pool.query(
        "UPDATE energy_settings SET automatic=true,approval_binding=$2,approved_by=$3 WHERE tenant_id=$1",
        [
          f.target.tenant,
          commissioningBinding(f.runtime.account, f.runtime.verification),
          f.target.user,
        ],
      );
      await quarantineEnergy(f.pool, f.target.tenant, "restore");
      assert.equal((await f.state()).automatic, false);
      assert.equal((await f.state()).plan.state, "cancelled");
    } finally {
      await f.dispose();
    }
  });
  test("energy native night windows are audited, expire durably and restore normal battery use", async () => {
    const f = await fixture();
    try {
      await f.approve();
      let value = await f.refresh();
      assert.equal(
        (
          await f.call("apply", {
            revision: value.revision,
            planId: value.plan.id,
            choice: "tonight",
            currentPassword: password,
          })
        ).status,
        202,
      );
      const plan = (
        await f.pool.query("SELECT * FROM energy_plans WHERE id=$1", [
          value.plan.id,
        ])
      ).rows[0];
      const now = Date.now(),
        prediction = {
          ...plan.prediction,
          night: {
            start: now - 60000,
            end: now + 3600000,
            releaseAt: now + 3480000,
          },
          chargeStart: now + 60000,
          chargeEnd: now + 3480000,
        };
      const windows = nightNativeWindows(prediction, plan.profile.timezone);
      await f.pool.query(
        "UPDATE energy_plans SET state='starting',prediction=$2,starts_at=$3,ends_at=$4 WHERE id=$1",
        [
          plan.id,
          prediction,
          new Date(prediction.night.start),
          new Date(prediction.night.releaseAt),
        ],
      );
      await f.runtime.outage.prepare(
        f.user,
        { targetSoc: prediction.targetSoc },
        plan.id,
        {
          planId: plan.id,
          endsAt: new Date(prediction.night.releaseAt),
          windows,
        },
      );
      await f.runtime.work.idle();
      await f.runtime.outage.load();
      assert.equal(
        f.runtime.outage.row.state,
        "active",
        JSON.stringify(f.runtime.outage.row),
      );
      assert.equal(f.runtime.outage.row.purpose, "night");
      assert.deepEqual(f.runtime.outage.row.planned_windows, windows);
      assert.equal(f.device.holding.get(2500), 3);
      assert.equal(f.device.holding.get(3005), 1000);
      await f.pool.query(
        "UPDATE outage_preparations SET ends_at=clock_timestamp()-interval '1 second' WHERE id=$1",
        [f.runtime.outage.row.id],
      );
      assert.equal(await f.runtime.outage.recover(), true);
      assert.equal(f.runtime.outage.row.state, "restored");
      assert.equal(f.device.holding.get(2500), 0);
      assert.equal(f.device.holding.get(2505), 500);
      assert.equal(f.device.holding.get(3036), 500);
      assert.equal(
        (
          await f.pool.query(
            "SELECT count(*)::int AS n FROM outage_write_intents WHERE preparation_id=$1 AND status<>'verified'",
            [f.runtime.outage.row.id],
          )
        ).rows[0].n,
        0,
      );
      const assess = f.hub.energy.assess, writes = f.device.writes.length;
      let assessments = 0;
      f.hub.energy.assess = async (...args) => {
        assessments++;
        if (assessments === 1) throw new Error("fixture assessment unavailable");
        return assess.call(f.hub.energy, ...args);
      };
      try {
        await assert.rejects(f.hub.energy.tick(), /fixture assessment unavailable/);
        assert.notEqual((await f.state()).plan.state, "completed");
        await f.hub.energy.tick();
        assert.equal((await f.state()).plan.state, "completed");
        assert.equal(assessments, 2);
        assert.equal((await f.state()).automatic, false);
        assert.equal(f.device.writes.length, writes);
      } finally {
        f.hub.energy.assess = assess;
      }
    } finally {
      await f.dispose();
    }
  });
  test("energy scheduler rechecks a real due window and an outage request preempts the night hold exactly once", async () => {
    const f = await fixture();
    try {
      await f.approve();
      const profile = energyProfile(),
        parts = new Intl.DateTimeFormat("en-GB", {
          timeZone: profile.timezone,
          hourCycle: "h23",
          hour: "2-digit",
          minute: "2-digit",
        }).formatToParts(new Date());
      const hour = Number(parts.find((part) => part.type === "hour").value),
        minute = Number(parts.find((part) => part.type === "minute").value),
        start = (Math.floor((hour * 60 + minute) / 15) * 15 - 15 + 1440) % 1440;
      profile.tariff.windows = [
        {
          months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
          startMinute: start,
          endMinute: (start + 360) % 1440,
        },
      ];
      let current = await f.state();
      assert.equal(
        (await f.call("settings", { revision: current.revision, profile }))
          .status,
        202,
      );
      current = await f.refresh();
      assert.equal(current.plan.prediction.action, "charge-and-hold");
      const adjusted = await f.call("adjust", {
        revision: current.revision,
        planId: current.plan.id,
        targetSoc: 85,
      });
      assert.equal(adjusted.status, 202);
      await f.hub.energy.pending.get(f.target.tenant);
      current = await f.state();
      assert.equal(current.plan.prediction.targetSoc, 85);
      const response = await f.call("apply", {
        revision: current.revision,
        planId: current.plan.id,
        choice: "tonight",
        currentPassword: password,
      });
      assert.equal(response.status, 202, await response.clone().text());
      const settings = await f.hub.energy.settings(f.target.tenant),
        plan = (
          await f.pool.query("SELECT * FROM energy_plans WHERE id=$1", [
            current.plan.id,
          ])
        ).rows[0];
      const approved = JSON.stringify(plan.approved_snapshot);
      await f.hub.energy.begin(f.runtime, settings, plan);
      await f.runtime.work.idle();
      await f.runtime.outage.load();
      assert.equal(
        f.runtime.outage.row.state,
        "active",
        JSON.stringify((await f.state()).plan),
      );
      assert.equal(f.runtime.outage.row.purpose, "night");
      assert.equal(f.runtime.outage.row.target_soc, 85);
      const frozen = (
        await f.pool.query(
          "SELECT approved_snapshot FROM energy_plans WHERE id=$1",
          [plan.id],
        )
      ).rows[0];
      assert.equal(JSON.stringify(frozen.approved_snapshot), approved);
      const key = randomUUID(),
        request = () =>
          fetchApi("/outage/prepare", {
            auth: f.member,
            method: "POST",
            idempotency: key,
            body: { targetSoc: 90 },
          });
      const both = await Promise.all([request(), request()]);
      for (const result of both)
        assert.equal(result.status, 202, await result.clone().text());
      assert.equal((await both[0].json()).id, (await both[1].json()).id);
      await f.runtime.work.idle();
      await f.runtime.outage.load();
      assert.equal(f.runtime.outage.row.state, "active");
      assert.equal(f.runtime.outage.row.purpose, "outage");
      assert.equal(f.runtime.outage.row.target_soc, 90);
      assert.equal(f.device.holding.get(2500), 3);
      await f.pool.query(
        "UPDATE energy_plans SET ends_at=clock_timestamp()-interval '1 second' WHERE id=$1",
        [plan.id],
      );
      await f.hub.energy.releaseDue();
      await Promise.allSettled([...f.hub.energy.releasing.values()]);
      assert.equal(f.runtime.outage.row.purpose, "outage");
      assert.equal(f.runtime.outage.row.state, "active");
      await f.restore();
    } finally {
      await f.dispose();
    }
  });
  test("energy settings and frozen forecasts are exported and a suspended workspace cannot refresh or adjust", async () => {
    const f = await fixture();
    try {
      const value = await f.refresh();
      const exported = await fetchApi("/workspace/archive", {
        auth: f.member,
        method: "POST",
        body: { currentPassword: password },
      });
      assert.equal(exported.status, 200);
      const archive = await exported.text();
      assert.ok(archive.includes("energySettings"));
      assert.ok(archive.includes("energyForecasts"));
      assert.ok(archive.includes(value.plan.id));
      await f.pool.query(
        "UPDATE tenants SET lifecycle='suspended' WHERE id=$1",
        [f.target.tenant],
      );
      assert.equal(
        (await f.call("refresh", { revision: value.revision })).status,
        409,
      );
      assert.equal(
        (
          await f.call("adjust", {
            revision: value.revision,
            planId: value.plan.id,
            targetSoc: 80,
          })
        ).status,
        409,
      );
      assert.equal(f.device.writes.length, 0);
    } finally {
      await f.dispose();
    }
  });
  test("energy Automatic can be enabled when the current recommendation needs no charging", async () => {
    const f = await fixture();
    try {
      await f.approve();
      const profile = energyProfile();
      profile.tariff.nightPrice = profile.tariff.dayPrice;
      let value = await f.state();
      assert.equal(
        (await f.call("settings", { revision: value.revision, profile }))
          .status,
        202,
      );
      value = await f.refresh();
      assert.equal(value.plan.prediction.action, "normal");
      const before = f.device.writes.length;
      const response = await f.call("apply", {
        revision: value.revision,
        planId: value.plan.id,
        choice: "automatic",
        currentPassword: password,
      });
      assert.equal(response.status, 202, await response.clone().text());
      const saved = await f.state();
      assert.equal(saved.automatic, true);
      assert.equal(saved.plan.state, "scheduled");
      assert.equal(f.device.writes.length, before);
    } finally {
      await f.dispose();
    }
  });
  test("energy admission refuses a fourth simultaneous restoration without changing its plan", async () => {
    const f = await fixture(),
      plans = [],
      forecasts = [],
      owners = [];
    try {
      await f.approve();
      const value = await f.refresh();
      const source = (
        await f.pool.query("SELECT * FROM energy_plans WHERE id=$1", [
          value.plan.id,
        ])
      ).rows[0];
      for (let index = 0; index < 3; index++) {
        const owner = {
          tenant_id: randomUUID(),
          id: randomUUID(),
          device_sn: `capacity-${randomUUID()}`,
        };
        await f.pool.query(
          "INSERT INTO tenants(id,name) VALUES($1,'Isolated night capacity canary')",
          [owner.tenant_id],
        );
        owners.push(owner);
        await f.pool.query(
          "INSERT INTO solarman_accounts(id,tenant_id,email,credentials,device_sn) VALUES($1,$2,'capacity-canary@example.invalid',$3,$4)",
          [
            owner.id,
            owner.tenant_id,
            encryptCredentials(
              { passwordSha256: "a".repeat(64) },
              f.hub.key,
              owner.tenant_id,
              owner.id,
            ),
            owner.device_sn,
          ],
        );
      }
      for (const owner of owners) {
        const forecastId = randomUUID(),
          planId = randomUUID();
        await f.pool.query(
          "INSERT INTO energy_forecasts(id,tenant_id,site_hash,fetched_at,expires_at,payload) SELECT $1,$2,$3,fetched_at,expires_at,payload FROM energy_forecasts WHERE id=$4",
          [
            forecastId,
            owner.tenant_id,
            energySiteHash(source.profile),
            source.forecast_id,
          ],
        );
        forecasts.push(forecastId);
        await f.pool.query(
          "INSERT INTO energy_plans(id,tenant_id,account_id,device,forecast_id,settings_revision,profile_hash,profile,demand,reading,prediction,state,starts_at,ends_at) VALUES($1,$2,$3,$4,$5,1,$6,$7,$8,$9,$10,'scheduled',$11,$12)",
          [
            planId,
            owner.tenant_id,
            owner.id,
            owner.device_sn,
            forecastId,
            source.profile_hash,
            source.profile,
            source.demand,
            source.reading,
            source.prediction,
            source.starts_at,
            source.ends_at,
          ],
        );
        plans.push(planId);
      }
      const body = {
        revision: value.revision,
        planId: source.id,
        choice: "tonight",
        currentPassword: password,
      };
      const rejected = await f.call("apply", body);
      assert.equal(rejected.status, 409);
      assert.match((await rejected.json()).error, /Shared command capacity/);
      assert.equal((await f.state()).plan.state, "recommended");
      await f.pool.query("DELETE FROM energy_plans WHERE id=$1", [plans.pop()]);
      const accepted = await f.call("apply", body);
      assert.equal(accepted.status, 202, await accepted.clone().text());
    } finally {
      await f.pool.query("DELETE FROM energy_plans WHERE id=ANY($1::uuid[])", [
        plans,
      ]);
      await f.pool.query(
        "DELETE FROM energy_forecasts WHERE id=ANY($1::uuid[])",
        [forecasts],
      );
      await f.pool.query(
        "DELETE FROM solarman_accounts WHERE id=ANY($1::uuid[])",
        [owners.map((owner) => owner.id)],
      );
      await f.pool.query("DELETE FROM tenants WHERE id=ANY($1::uuid[])", [
        owners.map((owner) => owner.tenant_id),
      ]);
      await f.dispose();
    }
  });
}
