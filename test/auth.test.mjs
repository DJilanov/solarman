import test from "node:test";
import assert from "node:assert/strict";
import {
  hashPassword,
  verifyPassword,
  validPasswordHash,
  tokenHash,
  readCookie,
  equalToken,
  LoginLimiter,
} from "../src/auth.mjs";
import {
  encryptCredentials,
  decryptCredentials,
  encryptionKey,
} from "../src/credentials.mjs";
import { randomBytes, randomUUID } from "node:crypto";

test("passwords are salted and special characters remain significant", async () => {
  const password = "test-password=with-spaces ";
  const one = await hashPassword(password);
  const two = await hashPassword(password);
  assert.equal(validPasswordHash(one), true);
  assert.notEqual(one, two);
  assert.equal(await verifyPassword(password, one), true);
  assert.equal(await verifyPassword(password.trim(), one), false);
  assert.equal(await verifyPassword(password, null), false);
  assert.equal(await verifyPassword(password, "untrusted hash format"), false);
});

test("cookie parsing and CSRF comparison reject malformed tokens", () => {
  const token = "a".repeat(64);
  assert.equal(
    readCookie(`other=x; solarman_session=${token}`, "solarman_session"),
    token,
  );
  assert.equal(
    readCookie("solarman_session=malformed", "solarman_session"),
    null,
  );
  assert.equal(equalToken(token, token), true);
  assert.equal(equalToken(token, "b".repeat(64)), false);
  assert.equal(equalToken([], token), false);
  assert.notEqual(tokenHash(token), token);
});

test("linked credentials cannot be decrypted under another tenant or account", () => {
  const key = encryptionKey(randomBytes(32).toString("base64"));
  const tenant = randomUUID();
  const account = randomUUID();
  const secret = {
    passwordSha256: "a".repeat(64),
    appSecret: "private-test-secret",
  };
  const encrypted = encryptCredentials(secret, key, tenant, account);
  assert.deepEqual(decryptCredentials(encrypted, key, tenant, account), secret);
  assert.equal(JSON.stringify(encrypted).includes(secret.appSecret), false);
  assert.throws(
    () => decryptCredentials(encrypted, key, randomUUID(), account),
    /could not be decrypted/,
  );
  assert.throws(
    () => decryptCredentials(encrypted, key, tenant, randomUUID()),
    /could not be decrypted/,
  );
  assert.throws(() =>
    decryptCredentials(
      { ...encrypted, tag: randomBytes(16).toString("base64") },
      key,
      tenant,
      account,
    ),
  );
});

test("login limiter bounds failed attempts and clears after a successful login", () => {
  const limiter = new LoginLimiter();
  for (let i = 0; i < 8; i++) assert.equal(limiter.allow("client"), true);
  assert.equal(limiter.allow("client"), false);
  assert.equal(limiter.allow("another-client"), true);
  limiter.clear("client");
  assert.equal(limiter.allow("client"), true);
});
