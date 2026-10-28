import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/** @param {object} value @param {Buffer} key @param {string} context @returns {object} */
export function sealSecret(value, key, context) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(context));
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

/** @param {unknown} encrypted @param {Buffer} key @param {string} context @returns {unknown} */
export function openSecret(encrypted, key, context) {
  if (
    !encrypted ||
    typeof encrypted !== "object" ||
    !("version" in encrypted) ||
    encrypted.version !== 1 ||
    !("nonce" in encrypted) ||
    typeof encrypted.nonce !== "string" ||
    !("tag" in encrypted) ||
    typeof encrypted.tag !== "string" ||
    !("ciphertext" in encrypted) ||
    typeof encrypted.ciphertext !== "string"
  )
    throw new Error("Invalid stored secret");
  const nonce = Buffer.from(encrypted.nonce, "base64");
  const tag = Buffer.from(encrypted.tag, "base64");
  if (nonce.length !== 12 || tag.length !== 16)
    throw new Error("Invalid stored secret");
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(tag);
  return JSON.parse(
    Buffer.concat([
      decipher.update(Buffer.from(encrypted.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8"),
  );
}
