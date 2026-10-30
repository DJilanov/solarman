import test from "node:test";
import assert from "node:assert/strict";
import { createECDH, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import webpush from "web-push";
import {
  normalizePushSubscription,
  encryptPushSubscription,
  decryptPushSubscription,
  pushEndpointHash,
  webPushConfiguration,
  sendWebPush,
} from "../src/web-push.mjs";

function fixture() {
  const server = webpush.generateVAPIDKeys();
  const device = createECDH("prime256v1");
  device.generateKeys();
  const subscription = {
    endpoint: "https://web.push.apple.com/test-private-endpoint",
    keys: {
      p256dh: device.getPublicKey().toString("base64url"),
      auth: randomBytes(16).toString("base64url"),
    },
  };
  const vapid = webPushConfiguration({
    PUBLIC_URL: "https://solarman.example.test",
    WEB_PUSH_PUBLIC_KEY: server.publicKey,
    WEB_PUSH_PRIVATE_KEY: server.privateKey,
  });
  return {
    subscription,
    vapid,
    payload: { title: "Private test title", body: "Private test body" },
  };
}

test("push subscriptions reject SSRF targets, credentials, invalid points and malformed auth keys", () => {
  const f = fixture();
  assert.deepEqual(normalizePushSubscription(f.subscription), f.subscription);
  for (const endpoint of [
    "http://web.push.apple.com/x",
    "https://127.0.0.1/x",
    "https://localhost/x",
    "https://web.push.apple.com.evil.test/x",
    "https://web.push.apple.com:8443/x",
    "https://user:secret@web.push.apple.com/x",
    "https://web.push.apple.com/x#secret",
    "https://169.254.169.254/latest/meta-data",
    "https://fcm.googleapis.com/",
  ]) {
    assert.throws(() =>
      normalizePushSubscription({ ...f.subscription, endpoint }),
    );
  }
  for (const keys of [
    { ...f.subscription.keys, auth: "not-auth" },
    { ...f.subscription.keys, p256dh: Buffer.alloc(65).toString("base64url") },
    { ...f.subscription.keys, p256dh: "x".repeat(9000) },
  ]) {
    assert.throws(() => normalizePushSubscription({ ...f.subscription, keys }));
  }
  for (const endpoint of [
    "https://fcm.googleapis.com/fcm/send/test",
    "https://updates.push.services.mozilla.com/wpush/v2/test",
  ]) {
    assert.equal(
      normalizePushSubscription({ ...f.subscription, endpoint }).endpoint,
      endpoint,
    );
  }
  assert.match(pushEndpointHash(f.subscription), /^[a-f0-9]{64}$/);
});

test("push secrets are encrypted and bound to their workspace and channel", () => {
  const f = fixture();
  const key = randomBytes(32);
  const secret = encryptPushSubscription(
    f.subscription,
    key,
    "tenant-a",
    "channel-a",
  );
  const stored = JSON.stringify(secret);
  assert.ok(!stored.includes(f.subscription.endpoint));
  assert.ok(!stored.includes(f.subscription.keys.auth));
  assert.deepEqual(
    decryptPushSubscription(secret, key, "tenant-a", "channel-a"),
    f.subscription,
  );
  assert.throws(() =>
    decryptPushSubscription(secret, key, "tenant-b", "channel-a"),
  );
  assert.throws(() =>
    decryptPushSubscription(secret, key, "tenant-a", "channel-b"),
  );
  assert.throws(() =>
    decryptPushSubscription(secret, randomBytes(32), "tenant-a", "channel-a"),
  );
  assert.equal(webPushConfiguration({}), null);
  assert.throws(() =>
    webPushConfiguration({ WEB_PUSH_PUBLIC_KEY: f.vapid.publicKey }),
  );
  assert.throws(() =>
    webPushConfiguration({
      PUBLIC_URL: "https://solarman.example.test",
      WEB_PUSH_PUBLIC_KEY: fixture().vapid.publicKey,
      WEB_PUSH_PRIVATE_KEY: f.vapid.privateKey,
    }),
  );
});

test("web push encrypts its payload and reports provider acceptance separately from device display", async () => {
  const f = fixture();
  let calls = 0;
  const result = await sendWebPush(f, async (url, options) => {
    calls++;
    assert.equal(url, f.subscription.endpoint);
    assert.equal(options.redirect, "error");
    assert.equal(options.headers.TTL, 300);
    assert.equal(options.headers["Content-Encoding"], "aes128gcm");
    assert.ok(!options.body.toString().includes(f.payload.body));
    assert.ok(options.signal instanceof AbortSignal);
    return new Response(null, { status: 201 });
  });
  assert.equal(calls, 1);
  assert.deepEqual(result, {
    state: "delivered",
    code: "push_accepted",
    messageId: null,
  });
  assert.ok(!JSON.stringify(result).includes(f.subscription.endpoint));
});

test("web push classifies expiry, rejected credentials, limits and uncertain failures without returning response secrets", async () => {
  const f = fixture();
  for (const [status, expected] of [
    [410, "push_expired"],
    [404, "push_expired"],
    [403, "push_authorization_rejected"],
    [401, "push_authorization_rejected"],
    [503, "provider_unavailable"],
    [400, "provider_rejected"],
  ]) {
    const result = await sendWebPush(
      f,
      async () => new Response("PRIVATE-PROVIDER-BODY", { status }),
    );
    assert.equal(result.code, expected);
    assert.ok(!JSON.stringify(result).includes("PRIVATE"));
  }
  assert.deepEqual(
    await sendWebPush(
      f,
      async () =>
        new Response(null, { status: 429, headers: { "retry-after": "120" } }),
    ),
    { state: "retry", code: "rate_limited", retryAfter: 120 },
  );
  assert.equal(
    (
      await sendWebPush(
        f,
        async () =>
          new Response(null, {
            status: 429,
            headers: { "retry-after": "bad" },
          }),
      )
    ).code,
    "rate_limit_delay_unavailable",
  );
  assert.deepEqual(
    await sendWebPush(f, async () => {
      throw Error("PRIVATE-ENDPOINT");
    }),
    { state: "unconfirmed", code: "transport_unconfirmed" },
  );
  let called = false;
  const invalid = await sendWebPush(
    {
      ...f,
      subscription: { ...f.subscription, endpoint: "https://127.0.0.1/x" },
    },
    async () => {
      called = true;
    },
  );
  assert.equal(invalid.code, "invalid_configuration");
  assert.equal(called, false);
});

test("web push honors shutdown and a bounded absolute deadline", async (t) => {
  const f = fixture();
  const abort = new AbortController();
  abort.abort();
  assert.equal(
    (
      await sendWebPush({ ...f, signal: abort.signal }, async () => {
        throw Error("must not dispatch");
      })
    ).state,
    "cancelled",
  );
  t.mock.method(AbortSignal, "timeout", () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);
    return controller.signal;
  });
  const result = await sendWebPush(
    f,
    async (_url, options) =>
      await new Promise((_resolve, reject) => {
        options.signal.addEventListener(
          "abort",
          () => reject(Error("aborted")),
          { once: true },
        );
      }),
  );
  assert.equal(result.code, "delivery_timeout");
});

async function workerFixture() {
  const handlers = new Map();
  const notifications = [];
  const requests = [];
  const opened = [];
  const context = {
    self: {
      addEventListener: (type, handler) => handlers.set(type, handler),
      skipWaiting: async () => {},
      location: { origin: "https://solarman.example.test" },
      registration: {
        showNotification: async (title, options) => {
          notifications.push({ title, options });
        },
      },
      clients: {
        claim: async () => {},
        matchAll: async () => [],
        openWindow: async (url) => {
          opened.push(url);
        },
      },
    },
    URL,
    AbortController,
    setTimeout,
    clearTimeout,
    fetch: async (url, options) => {
      requests.push({ url, options });
      return new Response(null, { status: 202 });
    },
  };
  vm.runInNewContext(
    await readFile(new URL("../web/public/sw.js", import.meta.url), "utf8"),
    context,
  );
  const dispatch = async (type, properties) => {
    let pending;
    handlers.get(type)({
      ...properties,
      waitUntil: (value) => {
        pending = value;
      },
    });
    await pending;
  };
  return { handlers, notifications, requests, opened, context, dispatch };
}

test("push worker confirms display only after showing a notification and never caches or replays requests", async () => {
  const f = await workerFixture();
  assert.equal(f.handlers.has("fetch"), false);
  const receipt = {
    id: "11111111-1111-4111-a111-111111111111",
    attempt: "22222222-2222-4222-a222-222222222222",
    token: "a".repeat(64),
  };
  await f.dispatch("push", {
    data: {
      json: () => ({
        title: "Test",
        body: "Message",
        url: "https://evil.test",
        reference: receipt.id,
        receipt,
      }),
    },
  });
  assert.equal(f.notifications.length, 1);
  assert.equal(f.requests.length, 1);
  assert.equal(f.notifications[0].options.data.url, "/settings/health");
  assert.ok(!JSON.stringify(f.notifications).includes(receipt.token));
  assert.equal(f.requests[0].url, "/api/notifications/push/receipt");
  assert.deepEqual(JSON.parse(f.requests[0].options.body), receipt);
  await f.dispatch("notificationclick", {
    notification: { close: () => {}, data: { url: "https://evil.test" } },
  });
  assert.deepEqual(f.opened, ["https://solarman.example.test/settings/health"]);
});

test("push worker shows malformed payloads visibly and cannot acknowledge a failed display", async () => {
  const f = await workerFixture();
  await f.dispatch("push", {
    data: {
      json: () => {
        throw Error("bad JSON");
      },
    },
  });
  assert.equal(f.notifications[0].title, "Solarman");
  assert.equal(f.requests.length, 0);
  f.context.self.registration.showNotification = async () => {
    throw Error("permission denied");
  };
  await assert.rejects(
    f.dispatch("push", {
      data: {
        json: () => ({
          title: "Test",
          body: "Message",
          receipt: {
            id: "11111111-1111-4111-a111-111111111111",
            attempt: "22222222-2222-4222-a222-222222222222",
            token: "b".repeat(64),
          },
        }),
      },
    }),
  );
  assert.equal(f.requests.length, 0);
});

test("energy notifications open the energy assistant while rejecting external or unknown paths", async () => {
  const f = await workerFixture();
  for (const path of ["/controls/energy-tools", "https://evil.test/controls/energy-tools", "/api/commands"]) {
    const expected = path === "/controls/energy-tools" ? path : "/settings/health";
    await f.dispatch("push", { data: { json: () => ({ title: "Energy", body: "Open your dashboard", url: path }) } });
    assert.equal(f.notifications.at(-1).options.data.url, expected);
    await f.dispatch("notificationclick", { notification: { close() {}, data: { url: path } } });
    assert.equal(f.opened.at(-1), `https://solarman.example.test${expected}`);
  }
});
