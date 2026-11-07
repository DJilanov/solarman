import { randomUUID } from "node:crypto";
import { enqueueNotification } from "./notification-store.mjs";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

/** @param {unknown} value @returns {object} */
export function nightTrialConfig(value) {
  const fields = [
    "version",
    "trialId",
    "tenantId",
    "userId",
    "activationKey",
    "stopKey",
    "reviewKey",
    "expiresAt",
    "reviewAt",
  ];
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !fields.includes(key)) ||
    value.version !== 1 ||
    [
      "trialId",
      "tenantId",
      "userId",
      "activationKey",
      "stopKey",
      "reviewKey",
    ].some((key) => typeof value[key] !== "string" || !UUID.test(value[key])) ||
    new Set([
      value.trialId,
      value.activationKey,
      value.stopKey,
      value.reviewKey,
    ]).size !== 4
  )
    throw new Error("Invalid night trial configuration");
  const end = Date.parse(value.expiresAt),
    review = Date.parse(value.reviewAt);
  if (
    ![value.expiresAt, value.reviewAt].every(
      (time) =>
        typeof time === "string" &&
        time.endsWith("Z") &&
        Number.isFinite(Date.parse(time)) &&
        new Date(time).toISOString() === time,
    ) ||
    !Number.isFinite(end) ||
    !Number.isFinite(review) ||
    review <= end ||
    review - end > 86400000
  )
    throw new Error("Invalid night trial dates");
  return Object.fromEntries(fields.map((field) => [field, value[field]]));
}

/** @param {import('pg').Pool} pool @param {object} input @returns {Promise<object>} */
export async function registerNightTrial(pool, input) {
  const config = nightTrialConfig(input);
  const result = await pool.query(
    "INSERT INTO energy_events(id,tenant_id,user_id,idempotency_key,action,result) SELECT $1,$2,$3,$4,'trial-scheduled',$5 FROM users u JOIN tenants t ON t.id=u.tenant_id WHERE u.tenant_id=$2 AND u.id=$3 AND t.lifecycle='active' ON CONFLICT(tenant_id,user_id,idempotency_key) DO NOTHING RETURNING id",
    [randomUUID(), config.tenantId, config.userId, config.trialId, { config }],
  );
  if (!result.rowCount) {
    const prior = (
      await pool.query(
        "SELECT result FROM energy_events WHERE tenant_id=$1 AND user_id=$2 AND idempotency_key=$3 AND action='trial-scheduled'",
        [config.tenantId, config.userId, config.trialId],
      )
    ).rows[0];
    if (
      !prior ||
      JSON.stringify(nightTrialConfig(prior.result.config)) !==
        JSON.stringify(config)
    )
      throw new Error("Night trial registration does not match");
  }
  return { state: "registered" };
}

/** @param {import('pg').PoolClient} client @param {object} config @returns {Promise<boolean>} */
async function permanentTrial(client, config) {
  const result = await client.query(
    "SELECT 1 FROM energy_events WHERE tenant_id=$1 AND user_id=$2 AND action='trial-permanent' AND result->>'trialId'=$3 AND result->>'activationKey'=$4 LIMIT 1",
    [config.tenantId, config.userId, config.trialId, config.activationKey],
  );
  return result.rowCount > 0;
}

/** @param {import('pg').Pool} pool @param {object} input @param {number} [now] @returns {Promise<object>} */
export async function makeNightTrialPermanent(pool, input, now = Date.now()) {
  const config = nightTrialConfig(input);
  if (!Number.isFinite(now) || now <= 0)
    throw new Error("Invalid night trial time");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const tenant = (
      await client.query("SELECT lifecycle FROM tenants WHERE id=$1 FOR UPDATE", [config.tenantId])
    ).rows[0];
    const owner = (
      await client.query("SELECT 1 FROM users WHERE tenant_id=$1 AND id=$2", [config.tenantId, config.userId])
    ).rowCount;
    if (tenant?.lifecycle !== "active" || !owner) {
      await client.query("COMMIT");
      return { state: "unavailable" };
    }
    const registered = (
      await client.query(
        "SELECT result->'config' AS config FROM energy_events WHERE tenant_id=$1 AND user_id=$2 AND idempotency_key=$3 AND action='trial-scheduled'",
        [config.tenantId, config.userId, config.trialId],
      )
    ).rows[0];
    if (
      !registered ||
      JSON.stringify(nightTrialConfig(registered.config)) !== JSON.stringify(config)
    )
      throw new Error("Night trial registration does not match");
    if (await permanentTrial(client, config)) {
      await client.query("COMMIT");
      return { state: "permanent" };
    }
    const settings = (
      await client.query(
        "SELECT automatic,revision,approval_binding,approved_by FROM energy_settings WHERE tenant_id=$1 FOR UPDATE",
        [config.tenantId],
      )
    ).rows[0];
    const latest = (
      await client.query(
        "SELECT idempotency_key,user_id,action FROM energy_events WHERE tenant_id=$1 AND action IN('settings','apply','pause') ORDER BY created_at DESC,id DESC LIMIT 1",
        [config.tenantId],
      )
    ).rows[0];
    let state;
    if (
      latest?.action !== "apply" ||
      latest.idempotency_key !== config.activationKey ||
      latest.user_id !== config.userId
    ) state = "superseded";
    else if (
      !settings?.automatic || !settings.approval_binding ||
      settings.approved_by !== config.userId
    ) state = "already-off";
    else if (now >= Date.parse(config.expiresAt)) state = "expired";
    if (state) {
      await client.query("COMMIT");
      return { state };
    }
    // Retain the exact approved settings and any active night hold; only remove this trial's deadline.
    await client.query(
      "INSERT INTO energy_events(id,tenant_id,user_id,idempotency_key,action,result) VALUES($1,$2,$3,$4,'trial-permanent',$5)",
      [
        randomUUID(), config.tenantId, config.userId, randomUUID(),
        {
          trialId: config.trialId,
          activationKey: config.activationKey,
          settingsRevision: String(settings.revision),
          authorization: "owner-request-via-operator",
        },
      ],
    );
    await client.query("COMMIT");
    return { state: "permanent" };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** @param {import('pg').Pool} pool @param {string} tenantId @param {number} [now] @returns {Promise<object|null>} */
export async function expireDueNightTrial(pool, tenantId, now = Date.now()) {
  const row = (
    await pool.query(
      "SELECT e.result->'config' AS config FROM energy_events e JOIN LATERAL(SELECT idempotency_key,user_id FROM energy_events WHERE tenant_id=$1 AND action IN('settings','apply','pause') ORDER BY created_at DESC,id DESC LIMIT 1)a ON a.idempotency_key::text=e.result->'config'->>'activationKey' AND a.user_id::text=e.result->'config'->>'userId' WHERE e.tenant_id=$1 AND e.action='trial-scheduled' AND NOT EXISTS(SELECT 1 FROM energy_events p WHERE p.tenant_id=e.tenant_id AND p.user_id=e.user_id AND p.action='trial-permanent' AND p.result->>'trialId'=e.result->'config'->>'trialId' AND p.result->>'activationKey'=e.result->'config'->>'activationKey') ORDER BY e.created_at DESC LIMIT 1",
      [tenantId],
    )
  ).rows[0];
  if (!row) return null;
  const config = nightTrialConfig(row.config);
  if (config.tenantId !== tenantId)
    throw new Error("Night trial workspace does not match");
  if (now < Date.parse(config.expiresAt)) return null;
  return expireNightTrial(pool, config, now);
}

/** @param {import('pg').Pool} pool @param {object} config @param {'expire'|'review'} action @param {number} now @param {(client:import('pg').PoolClient)=>Promise<object>} operation @returns {Promise<object>} */
async function receipt(pool, config, action, now, operation) {
  if (!Number.isFinite(now) || now <= 0)
    throw new Error("Invalid night trial time");
  const deadline = Date.parse(
    action === "expire" ? config.expiresAt : config.reviewAt,
  );
  if (now < deadline) return { state: "not-due" };
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const tenant = (
      await client.query(
        "SELECT lifecycle FROM tenants WHERE id=$1 FOR UPDATE",
        [config.tenantId],
      )
    ).rows[0];
    const owner = (
      await client.query("SELECT 1 FROM users WHERE tenant_id=$1 AND id=$2", [
        config.tenantId,
        config.userId,
      ])
    ).rowCount;
    if (tenant?.lifecycle !== "active" || !owner) {
      await client.query("COMMIT");
      return { state: "unavailable" };
    }
    const key = action === "expire" ? config.stopKey : config.reviewKey;
    const prior = (
      await client.query(
        "SELECT result FROM energy_events WHERE tenant_id=$1 AND user_id=$2 AND idempotency_key=$3",
        [config.tenantId, config.userId, key],
      )
    ).rows[0];
    if (prior) {
      await client.query("COMMIT");
      return prior.result.value;
    }
    const result = await operation(client);
    await client.query(
      "INSERT INTO energy_events(id,tenant_id,user_id,idempotency_key,action,result) VALUES($1,$2,$3,$4,$5,$6)",
      [
        randomUUID(),
        config.tenantId,
        config.userId,
        key,
        action === "expire" ? "trial-expired" : "trial-review",
        {
          trialId: config.trialId,
          activationKey: config.activationKey,
          dueAt: new Date(deadline).toISOString(),
          value: result,
        },
      ],
    );
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** @param {import('pg').Pool} pool @param {object} input @param {number} [now] @returns {Promise<object>} */
export async function expireNightTrial(pool, input, now = Date.now()) {
  const config = nightTrialConfig(input);
  return receipt(pool, config, "expire", now, async (client) => {
    if (await permanentTrial(client, config)) return { state: "permanent" };
    const settings = (
      await client.query(
        "SELECT automatic FROM energy_settings WHERE tenant_id=$1 FOR UPDATE",
        [config.tenantId],
      )
    ).rows[0];
    const latest = (
      await client.query(
        "SELECT idempotency_key,user_id FROM energy_events WHERE tenant_id=$1 AND action IN('settings','apply','pause') ORDER BY created_at DESC,id DESC LIMIT 1",
        [config.tenantId],
      )
    ).rows[0];
    if (
      latest?.idempotency_key !== config.activationKey ||
      latest.user_id !== config.userId
    )
      return { state: "superseded" };
    if (!settings?.automatic) return { state: "already-off" };
    // Match the normal pause path. Clearing approval also requests restoration of any remaining night hold.
    await client.query(
      "UPDATE energy_settings SET automatic=false,approval_binding=null,approved_by=null,revision=revision+1,updated_at=clock_timestamp() WHERE tenant_id=$1",
      [config.tenantId],
    );
    await client.query(
      "UPDATE energy_plans SET state='cancelled',code='paused',updated_at=clock_timestamp() WHERE tenant_id=$1 AND state IN('scheduled','recommended')",
      [config.tenantId],
    );
    return { state: "paused" };
  });
}

/** @param {import('pg').Pool} pool @param {object} input @param {number} [now] @returns {Promise<object>} */
export async function remindNightTrial(pool, input, now = Date.now()) {
  const config = nightTrialConfig(input);
  if (now < Date.parse(config.reviewAt)) return { state: "not-due" };
  await expireNightTrial(pool, config, now);
  return receipt(pool, config, "review", now, async (client) => {
    if (await permanentTrial(client, config)) return { state: "permanent", channels: 0 };
    const activated = (
      await client.query(
        "SELECT 1 FROM energy_events WHERE tenant_id=$1 AND user_id=$2 AND idempotency_key=$3 AND action='apply'",
        [config.tenantId, config.userId, config.activationKey],
      )
    ).rowCount;
    if (!activated) return { state: "not-activated", channels: 0 };
    const channels = (
      await client.query(
        "SELECT c.* FROM notification_channels c WHERE c.tenant_id=$1 AND c.user_id=$2 AND c.kind='webpush' AND c.enabled AND NOT c.quarantined AND c.revoked_at IS NULL AND c.verified_at IS NOT NULL AND c.secret IS NOT NULL AND EXISTS(SELECT 1 FROM energy_experience_settings s WHERE s.tenant_id=c.tenant_id AND s.briefings_enabled) FOR UPDATE",
        [config.tenantId, config.userId],
      )
    ).rows;
    const key = `night-trial:${config.trialId}:review`;
    for (const channel of channels) {
      const bg = channel.language === "bg";
      await enqueueNotification(client, channel, {
        id: randomUUID(),
        eventKey: key,
        kind: "energy-briefing",
        payload: {
          title: bg
            ? "Нощна икономия: преглед на тестовата седмица"
            : "Night savings: review the trial week",
          text: bg
            ? "Тестовата седмица приключи. Отвори седмичния енергиен отчет и се върни в разговора, за да обсъдим зареждането, прогнозата и разходите."
            : "The trial week has ended. Open the weekly energy report and return to our conversation to review charging, forecasts and costs.",
          url: "/controls/energy-tools",
          expiresAt: new Date(now + 2 * 3600000).toISOString(),
        },
      });
      const queued = (
        await client.query(
          "SELECT state FROM notification_outbox WHERE tenant_id=$1 AND channel_id=$2 AND channel_revision=$3 AND event_key=$4",
          [config.tenantId, channel.id, channel.revision, key],
        )
      ).rows[0];
      if (!queued || queued.state === "failed")
        throw new Error("Night trial review could not be queued");
    }
    return {
      state: channels.length ? "queued" : "no-channel",
      channels: channels.length,
    };
  });
}
