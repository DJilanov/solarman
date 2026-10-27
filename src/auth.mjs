import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
  createHash,
} from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
const OPTIONS = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

/** @param {string} password @returns {Promise<string>} */
export async function hashPassword(password) {
  if (
    typeof password !== "string" ||
    password.length < 8 ||
    password.length > 1024
  )
    throw new Error("Password must contain 8 to 1024 characters");
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 64, OPTIONS);
  return `scrypt$32768$8$1$${salt.toString("hex")}$${hash.toString("hex")}`;
}

/** @param {string} hash @returns {boolean} */
export function validPasswordHash(hash) {
  return /^scrypt\$32768\$8\$1\$[a-f0-9]{32}\$[a-f0-9]{128}$/.test(hash);
}

/** @param {string} password @param {string | null} stored @returns {Promise<boolean>} */
export async function verifyPassword(password, stored) {
  if (typeof password !== "string" || password.length > 1024) return false;
  const valid = typeof stored === "string" && validPasswordHash(stored);
  const salt = valid
    ? Buffer.from(stored.split("$")[4], "hex")
    : Buffer.alloc(16);
  const expected = valid
    ? Buffer.from(stored.split("$")[5], "hex")
    : Buffer.alloc(64);
  const actual = await scrypt(password, salt, 64, OPTIONS);
  return timingSafeEqual(actual, expected) && valid;
}

/** @param {string} token @returns {string} */
export function tokenHash(token) {
  return createHash("sha256").update(token).digest("hex");
}

/** @returns {string} */
export function randomToken() {
  return randomBytes(32).toString("hex");
}

/** @param {string | undefined} header @param {string} name @returns {string | null} */
export function readCookie(header, name) {
  for (const part of (header ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index >= 0 && part.slice(0, index).trim() === name) {
      const token = part.slice(index + 1).trim();
      return /^[a-f0-9]{64}$/.test(token) ? token : null;
    }
  }
  return null;
}

/** @param {string} a @param {string} b @returns {boolean} */
export function equalToken(a, b) {
  return (
    typeof a === "string" &&
    typeof b === "string" &&
    /^[a-f0-9]{64}$/.test(a) &&
    /^[a-f0-9]{64}$/.test(b) &&
    timingSafeEqual(Buffer.from(a), Buffer.from(b))
  );
}

export class LoginLimiter {
  constructor() {
    this.entries = new Map();
  }
  /** @param {string} key @returns {boolean} */
  allow(key) {
    const now = Date.now();
    for (const [entry, value] of this.entries)
      if (value.expiresAt <= now) this.entries.delete(entry);
    const value = this.entries.get(key);
    if (value && value.count >= 8) return false;
    if (!value && this.entries.size >= 5000) return false;
    this.entries.set(key, {
      count: (value?.count ?? 0) + 1,
      expiresAt: value?.expiresAt ?? now + 15 * 60_000,
    });
    return true;
  }
  /** @param {string} key @returns {void} */
  clear(key) {
    this.entries.delete(key);
  }
}
