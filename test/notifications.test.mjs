import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID, createCipheriv } from "node:crypto";
import { sendTelegram } from "../src/telegram.mjs";
import {
  encryptNotificationSecret,
  decryptNotificationSecret,
  validTelegramChat,
  validTelegramToken,
} from "../src/notification-secrets.mjs";
import { decryptCredentials } from "../src/credentials.mjs";
import { incidentNotification } from "../src/notification-messages.mjs";
import { Notifications } from "../src/notifications.mjs";

const botToken = "123456789:" + "f".repeat(35);
const chatId = "-1001234567890";
const input = { botToken, chatId, text: "Notification fixture" };

test("notification dispatch stops when scheduler ownership is lost before or during its permission check", async () => {
  const hub = { env: {}, stopping: true };
  let checks = 0;
  let sends = 0;
  let outcome;
  const service = new Notifications(
    {
      query: async () => {
        checks++;
        hub.stopping = true;
        return { rowCount: 1 };
      },
    },
    hub,
    {
      send: async () => {
        sends++;
        throw new Error("Unexpected send");
      },
    },
  );
  service.platformAt = Date.now();
  service.recoverSending = async () => 0;
  service.claim = async () => ({ id: randomUUID(), tenant_id: randomUUID() });
  service.finish = async (_job, result) => {
    outcome = result;
  };
  await service.runOnce();
  assert.equal(checks, 0);
  hub.stopping = false;
  await service.runOnce();
  assert.equal(checks, 1);
  assert.equal(sends, 0);
  assert.deepEqual(outcome, {
    state: "cancelled",
    code: "cancelled_before_dispatch",
  });
});

function response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("Telegram confirms only a successful message for the exact configured destination and uses fixed HTTPS without formatting or paid broadcast", async () => {
  const result = await sendTelegram(input, async (url, init) => {
    assert.equal(
      String(url),
      `https://api.telegram.org/bot${botToken}/sendMessage`,
    );
    assert.equal(init.redirect, "error");
    assert.equal(init.method, "POST");
    assert.deepEqual(JSON.parse(init.body), {
      chat_id: chatId,
      text: input.text,
      link_preview_options: { is_disabled: true },
    });
    return response({
      ok: true,
      result: { message_id: 75, chat: { id: Number(chatId) } },
    });
  });
  assert.deepEqual(result, {
    state: "delivered",
    code: "delivered",
    messageId: 75,
  });
  for (const body of [
    { ok: true },
    { ok: true, result: { message_id: 0, chat: { id: Number(chatId) } } },
    { ok: true, result: { message_id: 75, chat: { id: 1234 } } },
    { ok: true, result: { message_id: 75, chat: { id: chatId } } },
  ])
    assert.equal(
      (await sendTelegram(input, async () => response(body))).state,
      "unconfirmed",
    );
});

test("Telegram errors honor provider retry delay and never expose tokens, URLs or provider descriptions", async () => {
  for (const [status, body, expected] of [
    [
      429,
      { ok: false, error_code: 429, parameters: { retry_after: 735 } },
      { state: "retry", code: "rate_limited", retryAfter: 735 },
    ],
    [
      429,
      { ok: false, error_code: 429 },
      { state: "rejected", code: "rate_limit_delay_unavailable" },
    ],
    [
      429,
      { ok: false, error_code: 429, parameters: { retry_after: 999999999 } },
      { state: "rejected", code: "rate_limit_delay_unavailable" },
    ],
    [
      401,
      { ok: false, error_code: 401 },
      { state: "rejected", code: "bot_unauthorized" },
    ],
    [
      403,
      { ok: false, error_code: 403 },
      { state: "rejected", code: "destination_rejected" },
    ],
    [
      400,
      { ok: false, error_code: 400, parameters: { migrate_to_chat_id: 777 } },
      { state: "rejected", code: "destination_rejected" },
    ],
    [
      503,
      { ok: false, error_code: 503 },
      { state: "retry", code: "provider_unavailable" },
    ],
  ]) {
    const result = await sendTelegram(input, async () =>
      response({ ...body, description: botToken }, status),
    );
    assert.deepEqual(result, expected);
    assert.equal(JSON.stringify(result).includes(botToken), false);
  }
  assert.deepEqual(
    await sendTelegram(input, async () => {
      throw new Error(`Failed to fetch ${botToken}`);
    }),
    { state: "unconfirmed", code: "transport_unconfirmed" },
  );
});

test("malformed, oversized and contradictory Telegram responses remain unconfirmed", async () => {
  for (const makeResponse of [
    () => new Response("not-json"),
    () => new Response("x".repeat(16385)),
    () =>
      response(
        { ok: true, result: { message_id: 75, chat: { id: Number(chatId) } } },
        502,
      ),
    () => response(["ok"]),
  ])
    assert.equal(
      (await sendTelegram(input, async () => makeResponse())).state,
      "unconfirmed",
    );
});

test("configuration validation and pre-dispatch cancellation do not make network requests", async () => {
  let calls = 0;
  const transport = async () => {
    calls++;
    throw new Error("Forbidden");
  };
  for (const patch of [
    { botToken: "token/path" },
    { chatId: "@alias" },
    { chatId: "000123" },
    { chatId: String(2 ** 52) },
    { text: "" },
    { text: "x".repeat(4097) },
  ])
    assert.equal(
      (await sendTelegram({ ...input, ...patch }, transport)).state,
      "rejected",
    );
  assert.equal(
    (await sendTelegram({ ...input, signal: AbortSignal.abort() }, transport))
      .state,
    "cancelled",
  );
  assert.equal(calls, 0);
  assert.equal(validTelegramChat("123456789"), true);
  assert.equal(validTelegramChat(chatId), true);
  assert.equal(validTelegramToken(botToken), true);
});

test("notification secrets are encrypted and cannot be swapped across workspaces, channels or provider credentials", () => {
  const key = randomBytes(32),
    tenant = randomUUID(),
    channel = randomUUID();
  const encrypted = encryptNotificationSecret(botToken, key, tenant, channel);
  assert.equal(JSON.stringify(encrypted).includes(botToken), false);
  assert.equal(
    decryptNotificationSecret(encrypted, key, tenant, channel).botToken,
    botToken,
  );
  for (const [otherKey, otherTenant, otherChannel] of [
    [randomBytes(32), tenant, channel],
    [key, randomUUID(), channel],
    [key, tenant, randomUUID()],
  ])
    assert.throws(
      () =>
        decryptNotificationSecret(
          encrypted,
          otherKey,
          otherTenant,
          otherChannel,
        ),
      /could not be decrypted/,
    );
  assert.throws(
    () => decryptCredentials(encrypted, key, tenant, channel),
    /could not be decrypted/,
  );
});

test("provider encryption retains the exact legacy authenticated context and envelope", () => {
  const key = randomBytes(32),
    tenant = randomUUID(),
    account = randomUUID();
  const value = { passwordSha256: "a".repeat(64), appSecret: "legacy-fixture" };
  const nonce = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(`solarman:${tenant}:${account}:v1`));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);
  const legacy = {
    version: 1,
    nonce: nonce.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
  assert.deepEqual(decryptCredentials(legacy, key, tenant, account), value);
});

test("notification text uses fixed incident messages and never renders provider errors or markup", () => {
  const incident = {
    id: randomUUID(),
    kind: "cleanup_pending",
    severity: "critical",
    device: "fixture-device",
    last_seen_at: new Date(),
    resolved_at: new Date(),
    description: botToken,
  };
  const options = {
    language: "bg",
    origin: "https://solarman.example.test",
    reference: randomUUID(),
    name: "Home\nSecond line",
  };
  const text = incidentNotification(incident, "opened", options).text;
  assert.match(text, /Изключването на зареждането/);
  assert.match(text, /Home Second line/);
  assert.equal(text.includes(botToken), false);
  assert.match(
    incidentNotification(incident, "resolved", options).text,
    /Възстановено/,
  );
});
