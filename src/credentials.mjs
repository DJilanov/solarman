import { sealSecret, openSecret } from "./stored-secret.mjs";

/** @param {string} secret @returns {Buffer} */
export function encryptionKey(secret) {
  if (typeof secret !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(secret))
    throw new Error("CREDENTIAL_ENCRYPTION_KEY must be a 32-byte base64 key");
  const key = Buffer.from(secret, "base64");
  if (key.length !== 32) throw new Error("Invalid credential encryption key");
  return key;
}

/** @param {object} value @param {Buffer} key @param {string} tenantId @param {string} accountId @returns {object} */
export function encryptCredentials(value, key, tenantId, accountId) {
  return sealSecret(value, key, `solarman:${tenantId}:${accountId}:v1`);
}

/** @param {object} encrypted @param {Buffer} key @param {string} tenantId @param {string} accountId @returns {object} */
export function decryptCredentials(encrypted, key, tenantId, accountId) {
  try {
    const result = openSecret(
      encrypted,
      key,
      `solarman:${tenantId}:${accountId}:v1`,
    );
    if (
      !result ||
      typeof result !== "object" ||
      !("passwordSha256" in result) ||
      typeof result.passwordSha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(result.passwordSha256)
    )
      throw new Error("Invalid credentials");
    return result;
  } catch {
    throw new Error("Linked account credentials could not be decrypted");
  }
}

/** @param {import('pg').PoolClient|import('pg').Pool} client @param {Buffer} key @returns {Promise<number>} */
export async function verifyStoredCredentials(client, key) {
  const accounts = (
    await client.query("SELECT tenant_id,id,credentials FROM solarman_accounts")
  ).rows;
  let count = 0;
  for (const account of accounts) {
    if (account.credentials === null) {
      const retired = await client.query(
        "SELECT 1 FROM workspace_offboarding o JOIN tenants t ON t.id=o.tenant_id WHERE o.tenant_id=$1 AND t.lifecycle='offboarding' AND o.erasure_started_at IS NOT NULL AND o.completed_at IS NULL",
        [account.tenant_id],
      );
      if (!retired.rowCount)
        throw new Error("Missing credentials outside authorized erasure");
    } else {
      decryptCredentials(
        account.credentials,
        key,
        account.tenant_id,
        account.id,
      );
      count++;
    }
  }
  return count;
}
