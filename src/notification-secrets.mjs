import { sealSecret, openSecret } from "./stored-secret.mjs";

/** @param {unknown} token @returns {token is string} */
export function validTelegramToken(token) {
  return (
    typeof token === "string" &&
    /^[1-9][0-9]{0,15}:[A-Za-z0-9_-]{1,256}$/.test(token)
  );
}

/** @param {unknown} value @returns {value is string} */
export function validTelegramChat(value) {
  return (
    typeof value === "string" &&
    /^-?[1-9]\d{0,15}$/.test(value) &&
    Number.isSafeInteger(Number(value)) &&
    Math.abs(Number(value)) < 2 ** 52
  );
}

/** @param {string} botToken @param {Buffer} key @param {string} tenantId @param {string} channelId @returns {object} */
export function encryptNotificationSecret(botToken, key, tenantId, channelId) {
  if (!validTelegramToken(botToken))
    throw new Error("Invalid Telegram bot token");
  return sealSecret(
    { botToken },
    key,
    `solarman-notification:${tenantId}:${channelId}:v1`,
  );
}

/** @param {unknown} secret @param {Buffer} key @param {string} tenantId @param {string} channelId @returns {{botToken:string}} */
export function decryptNotificationSecret(secret, key, tenantId, channelId) {
  try {
    const value = openSecret(
      secret,
      key,
      `solarman-notification:${tenantId}:${channelId}:v1`,
    );
    if (
      !value ||
      typeof value !== "object" ||
      !("botToken" in value) ||
      !validTelegramToken(value.botToken)
    )
      throw new Error("Invalid secret");
    return { botToken: value.botToken };
  } catch {
    throw new Error("Notification credentials could not be decrypted");
  }
}

/** @param {import('pg').Pool|import('pg').PoolClient} client @param {Buffer} key @returns {Promise<void>} */
export async function verifyStoredNotificationSecrets(client, key) {
  if (
    !(
      await client.query(
        "SELECT to_regclass('public.notification_channels') AS name",
      )
    ).rows[0].name
  )
    return;
  const { rows } = await client.query(
    "SELECT tenant_id,id,secret FROM notification_channels",
  );
  for (const row of rows) {
    if (row.secret !== null)
      decryptNotificationSecret(row.secret, key, row.tenant_id, row.id);
    else if (
      !(
        await client.query(
          "SELECT 1 FROM workspace_offboarding o JOIN tenants t ON t.id=o.tenant_id WHERE o.tenant_id=$1 AND t.lifecycle='offboarding' AND o.erasure_started_at IS NOT NULL AND o.completed_at IS NULL",
          [row.tenant_id],
        )
      ).rowCount
    )
      throw new Error(
        "Missing notification credentials outside authorized erasure",
      );
  }
}
