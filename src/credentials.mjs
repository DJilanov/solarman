import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

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
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(`solarman:${tenantId}:${accountId}:v1`));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);
  return {
    version: 1,
    nonce: nonce.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

/** @param {object} encrypted @param {Buffer} key @param {string} tenantId @param {string} accountId @returns {object} */
export function decryptCredentials(encrypted, key, tenantId, accountId) {
  try {
    if (encrypted.version !== 1) throw new Error("Unknown version");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(encrypted.nonce, "base64"),
    );
    decipher.setAAD(Buffer.from(`solarman:${tenantId}:${accountId}:v1`));
    decipher.setAuthTag(Buffer.from(encrypted.tag, "base64"));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(encrypted.ciphertext, "base64")),
      decipher.final(),
    ]);
    const result = JSON.parse(plain.toString("utf8"));
    if (
      !result ||
      typeof result !== "object" ||
      !/^[a-f0-9]{64}$/.test(result.passwordSha256)
    )
      throw new Error("Invalid credentials");
    return result;
  } catch {
    throw new Error("Linked account credentials could not be decrypted");
  }
}
