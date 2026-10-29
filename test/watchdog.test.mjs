import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import {
  mkdtemp,
  writeFile,
  readFile,
  rm,
  chmod,
  symlink,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID, createECDH, randomBytes } from "node:crypto";
import webpush from "web-push";
import {
  probeWatchdogPermission,
  WATCHDOG_PERMISSION_MS,
} from "../src/watchdog-permission.mjs";
import {
  watchdogConfig,
  watchdogBindings,
  readWatchdogConfig,
  assertWatchdogInstallationTarget,
} from "../src/watchdog-config.mjs";
import { probeHealth, probeOrigin } from "../src/watchdog-probes.mjs";
import {
  readWatchdogState,
  writeWatchdogState,
} from "../src/watchdog-store.mjs";
import {
  pruneWatchdog,
  validateWatchdogState,
} from "../src/watchdog-state.mjs";
import { runWatchdog, currentWatchdogStatus } from "../src/watchdog.mjs";

const botToken = "123456789:" + "w".repeat(35);
const base = {
  version: 1,
  url: "https://solarman.example.test/healthz",
  originHost: "127.0.0.1",
  originPort: 443,
  label: "Home solar",
  language: "bg",
  delivery: null,
};
const delivery = { botToken, chatId: "-1001234567890", enabled: false };
const healthy = { healthy: true, code: "healthy", release: "a".repeat(40) };
const failed = { healthy: false, code: "http_error", release: null };

test("watchdog installation rejects development URLs and application or loopback monitoring hosts", () => {
  const config = watchdogConfig({ ...base, originHost: "192.0.2.10" });
  assert.doesNotThrow(() =>
    assertWatchdogInstallationTarget(config, "monitor.example.test", [
      { address: "203.0.113.10" },
    ]),
  );
  for (const [target, host, addresses] of [
    [
      watchdogConfig({ ...config, url: "http://localhost:3000/healthz" }),
      "monitor.example.test",
      [{ address: "203.0.113.10" }],
    ],
    [
      watchdogConfig({ ...config, url: "https://127.0.0.1/healthz" }),
      "monitor.example.test",
      [{ address: "203.0.113.10" }],
    ],
    [config, "solarman.example.test", [{ address: "203.0.113.10" }]],
    [config, "monitor.example.test", [{ address: "192.0.2.10" }]],
    [config, "monitor.example.test", [{ address: "::1" }]],
    [config, "monitor.example.test", []],
  ])
    assert.throws(
      () => assertWatchdogInstallationTarget(target, host, addresses),
      { code: "installation_target_invalid" },
    );
});

async function fixture(t, configured = true) {
  const directory = await mkdtemp(path.join(tmpdir(), "solarman-watchdog-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "config.json"),
    stateDirectory = path.join(directory, "state");
  const f = {
    directory,
    file,
    stateDirectory,
    config: { ...base, delivery: configured ? { ...delivery } : null },
    now: Date.parse("2026-10-29T12:00:00.000Z"),
    sent: [],
  };
  f.saveConfig = () =>
    writeFile(file, JSON.stringify(f.config), { mode: 0o600 });
  await f.saveConfig();
  f.sender = async (input) => {
    f.sent.push(input);
    return { state: "delivered", code: "delivered", messageId: f.sent.length };
  };
  f.run = (options = {}) =>
    runWatchdog(file, stateDirectory, {
      clock: () => f.now,
      healthProbe: async () => healthy,
      originProbe: async () => "reachable",
      send: (input) => f.sender(input),
      sendPush: (input) => f.pushSender(input),
      permissionProbe: async () => f.permission ?? "allowed",
      ...options,
    });
  f.state = () => readWatchdogState(stateDirectory);
  f.tick = async (good = true, options = {}) => {
    f.now += 60000;
    return f.run({
      healthProbe: async () => (good ? healthy : failed),
      ...options,
    });
  };
  f.enable = async () => {
    await f.run({ action: "test" });
    f.config.delivery.enabled = true;
    await f.saveConfig();
  };
  return f;
}

async function pushFixture(t) {
  const f = await fixture(t);
  const pair = createECDH("prime256v1");
  pair.generateKeys();
  f.config.delivery = {
    kind: "webpush",
    enabled: false,
    subscription: {
      endpoint: "https://web.push.apple.com/example-private-endpoint",
      keys: {
        p256dh: pair.getPublicKey().toString("base64url"),
        auth: randomBytes(16).toString("base64url"),
      },
    },
    vapid: {
      ...webpush.generateVAPIDKeys(),
      subject: new URL(base.url).origin,
    },
    permission: {
      url:
        new URL(base.url).origin +
        "/api/notifications/push/watchdog/" +
        randomUUID(),
      token: "e".repeat(64),
    },
  };
  f.pushSender = async (input) => {
    f.sent.push(input);
    return { state: "delivered", code: "push_accepted", messageId: null };
  };
  await f.saveConfig();
  f.enable = async () => {
    const status = await f.run({ action: "test" });
    await f.run({ action: "confirm-test", testId: status.testId });
    f.config.delivery.enabled = true;
    await f.saveConfig();
  };
  return f;
}

test("watchdog push configuration binds the exact destination, permission and keys without exposing them", async (t) => {
  const f = await pushFixture(t);
  const normalized = watchdogConfig(f.config);
  const before = watchdogBindings(normalized);
  assert.equal(
    before.destination,
    watchdogBindings({
      ...normalized,
      delivery: { ...normalized.delivery, enabled: true },
    }).destination,
  );
  for (const patch of [
    { kind: "other" },
    { vapid: { ...f.config.delivery.vapid, privateKey: "invalid" } },
    {
      permission: {
        ...f.config.delivery.permission,
        url:
          "https://other.example.test/api/notifications/push/watchdog/" +
          randomUUID(),
      },
    },
    { permission: { ...f.config.delivery.permission, token: "invalid" } },
    {
      subscription: {
        ...f.config.delivery.subscription,
        endpoint: "https://127.0.0.1/private",
      },
    },
  ])
    assert.throws(
      () =>
        watchdogConfig({
          ...f.config,
          delivery: { ...f.config.delivery, ...patch },
        }),
      { code: "configuration_invalid" },
    );
  assert.notEqual(
    before.destination,
    watchdogBindings(
      watchdogConfig({
        ...f.config,
        delivery: {
          ...f.config.delivery,
          permission: {
            ...f.config.delivery.permission,
            token: "f".repeat(64),
          },
        },
      }),
    ).destination,
  );
  const status = await f.run();
  const text = JSON.stringify(status);
  assert.equal(text.includes(f.config.delivery.vapid.privateKey), false);
  assert.equal(text.includes(f.config.delivery.subscription.endpoint), false);
  assert.equal(text.includes(f.config.delivery.permission.token), false);
});

test("watchdog permission reads require a fresh challenge and bounded authenticated response", async () => {
  const permission = {
    url: "https://example.test/api/notifications/push/watchdog/" + randomUUID(),
    token: "f".repeat(64),
  };
  for (const [status, allowed, expected] of [
    [200, true, "allowed"],
    [200, false, "denied"],
    [403, false, "denied"],
    [503, false, "unavailable"],
  ]) {
    assert.equal(
      await probeWatchdogPermission(permission, {
        transport: async (url, options) => {
          assert.equal(
            options.headers.authorization,
            "Bearer " + permission.token,
          );
          assert.equal(options.redirect, "error");
          return Response.json(
            { allowed, probe: new URL(url).searchParams.get("probe") },
            { status },
          );
        },
      }),
      expected,
    );
  }
  assert.equal(
    await probeWatchdogPermission(permission, {
      transport: async () =>
        Response.json({ allowed: true, probe: "a".repeat(32) }),
    }),
    "unavailable",
  );
  assert.equal(
    await probeWatchdogPermission(permission, {
      transport: async () => new Response(" ".repeat(4097)),
    }),
    "unavailable",
  );
  assert.equal(
    await probeWatchdogPermission(permission, {
      transport: async () => {
        throw new Error(permission.token);
      },
    }),
    "unavailable",
  );
});

test("push acceptance requires the operator's exact test confirmation before independent outage and recovery delivery", async (t) => {
  const f = await pushFixture(t);
  let status = await f.run({ action: "test" });
  assert.equal(status.verified, false);
  assert.equal(status.enabled, false);
  assert.equal(status.recent[0].lastCode, "push_accepted");
  await assert.rejects(
    f.run({ action: "confirm-test", testId: randomUUID() }),
    { code: "push_test_confirmation_invalid" },
  );
  status = await f.run({ action: "confirm-test", testId: status.testId });
  assert.equal(status.verified, true);
  assert.equal(status.enabled, false);
  assert.equal(status.recent[0].lastCode, "push_operator_confirmed");
  f.config.delivery.enabled = true;
  await f.saveConfig();
  await f.tick(false);
  await f.tick(false);
  status = await f.tick(false);
  assert.equal(status.condition, "down");
  assert.equal(f.sent.length, 2);
  await f.tick();
  status = await f.tick();
  assert.equal(status.condition, "healthy");
  assert.equal(f.sent.length, 3);
  assert.match(f.sent[1].payload.body, /не отговаря/);
  assert.match(f.sent[2].payload.body, /отново/);
  assert.equal(f.sent[1].payload.url, "/settings/health");
  assert.equal(f.sent[1].payload.receipt, undefined);
  assert.equal(f.sent[1].payload.body.includes(f.config.label), false);
  const state = await f.state();
  validateWatchdogState(state);
  assert.equal(state.jobs[0].history[0].code, "push_accepted");
  assert.ok(state.jobs[0].operatorConfirmedAt);
});

test("dashboard subscription revocation cancels independent delivery and a later lease does not restore approval", async (t) => {
  const f = await pushFixture(t);
  await f.enable();
  await f.tick(false);
  await f.tick(false);
  f.permission = "denied";
  let status = await f.tick(false);
  assert.equal(status.enabled, false);
  assert.equal(status.verified, false);
  assert.equal(status.blockedCode, "subscription_revoked");
  assert.equal(f.sent.length, 1);
  await assert.rejects(
    f.run({ action: "confirm-test", testId: status.testId }),
    { code: "subscription_permission_unavailable" },
  );
  f.permission = "allowed";
  status = await f.tick(false);
  assert.equal(status.enabled, false);
  assert.equal(status.verified, false);
  assert.equal(f.sent.length, 1);
});

test("a bounded permission lease delivers during an app outage but cannot test or continue indefinitely", async (t) => {
  const f = await pushFixture(t);
  await f.enable();
  await f.tick();
  f.permission = "unavailable";
  await assert.rejects(f.run({ action: "new-test" }), {
    code: "subscription_permission_unavailable",
  });
  await f.tick(false);
  await f.tick(false);
  let status = await f.tick(false);
  assert.equal(status.condition, "down");
  assert.equal(f.sent.length, 2);
  f.now += WATCHDOG_PERMISSION_MS;
  status = await f.run({ healthProbe: async () => failed });
  assert.equal(status.enabled, false);
  assert.equal(status.verified, false);
  assert.equal(status.blockedCode, "subscription_permission_expired");
  assert.equal(f.sent.length, 2);
});

test("restored push targets cannot reuse an accepted or operator-confirmed test", async (t) => {
  const f = await pushFixture(t);
  await f.enable();
  const old = (await f.state()).testId;
  let status = await f.run({ action: "quarantine" });
  assert.equal(status.enabled, false);
  assert.equal(status.verified, false);
  await assert.rejects(f.run({ action: "confirm-test", testId: old }), {
    code: "push_test_confirmation_invalid",
  });
  f.config.delivery.enabled = false;
  await f.saveConfig();
  status = await f.run({ action: "new-test" });
  assert.notEqual(status.testId, old);
  assert.equal(status.verified, false);
  status = await f.run({ action: "confirm-test", testId: status.testId });
  assert.equal(status.verified, true);
  assert.equal(status.enabled, false);
});

async function server(t, handler) {
  const instance = createServer(handler);
  await new Promise((resolve) => instance.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    instance.closeAllConnections();
    await new Promise((resolve) => instance.close(resolve));
  });
  return {
    instance,
    port: instance.address().port,
    url: `http://127.0.0.1:${instance.address().port}/healthz`,
  };
}

function healthBody(request, patch = {}) {
  return {
    status: "ok",
    release: "b".repeat(40),
    monitoring: "current",
    notifications: "current",
    probe: new URL(request.url, "http://localhost").searchParams.get("probe"),
    ...patch,
  };
}

test("watchdog configuration accepts a private destination without permitting arbitrary paths or secret-bearing URLs", () => {
  assert.deepEqual(watchdogConfig(base), base);
  for (const patch of [
    { url: "http://example.test/healthz" },
    { url: "https://user:private@example.test/healthz" },
    { url: base.url + "?secret=private" },
    { url: base.url + "#private" },
    { url: "https://example.test/other" },
    { originHost: "example.test" },
    { originPort: 0 },
    { originPort: 65536 },
    { language: "de" },
    { label: "Home\nOther" },
    { delivery: { ...delivery, chatId: "@someone" } },
    { delivery: { ...delivery, botToken: "private" } },
    { delivery: { ...delivery, enabled: "true" } },
  ])
    assert.throws(() => watchdogConfig({ ...base, ...patch }), {
      code: "configuration_invalid",
    });
  const a = watchdogBindings(watchdogConfig({ ...base, delivery }));
  assert.equal(
    a.destination,
    watchdogBindings(
      watchdogConfig({ ...base, delivery: { ...delivery, enabled: true } }),
    ).destination,
  );
  assert.notEqual(
    a.destination,
    watchdogBindings(
      watchdogConfig({ ...base, delivery: { ...delivery, chatId: "1234" } }),
    ).destination,
  );
  assert.equal(JSON.stringify(a).includes(botToken), false);
});

test("watchdog private files reject symlinks and public access and never reset corrupt state", async (t) => {
  const f = await fixture(t);
  await chmod(f.file, 0o644);
  await assert.rejects(readWatchdogConfig(f.file), {
    code: "private_file_permissions",
  });
  await chmod(f.file, 0o600);
  const linked = path.join(f.directory, "linked.json");
  await symlink(f.file, linked);
  await assert.rejects(readWatchdogConfig(linked));
  await f.run();
  const file = path.join(f.stateDirectory, "state.json");
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  await writeFile(file, '{"version":1}', { mode: 0o600 });
  await assert.rejects(f.run(), { code: "state_invalid" });
  assert.equal(await readFile(file, "utf8"), '{"version":1}');
  assert.equal(f.sent.length, 0);
});

test("fresh health checks challenge every response and distinguish a stopped application from an answering origin socket", async (t) => {
  const probes = [];
  const app = await server(t, (request, response) => {
    probes.push(
      new URL(request.url, "http://localhost").searchParams.get("probe"),
    );
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(healthBody(request)));
  });
  const s = await server(t, async (request, response) => {
    try {
      const upstream = await fetch(new URL(request.url, app.url));
      response.statusCode = upstream.status;
      response.end(await upstream.text());
    } catch {
      response.statusCode = 502;
      response.end("Fixture application stopped");
    }
  });
  assert.equal((await probeHealth(s.url)).healthy, true);
  assert.equal((await probeHealth(s.url)).healthy, true);
  assert.notEqual(probes[0], probes[1]);
  assert.match(probes[0], /^[a-f0-9]{32}$/);
  assert.equal(await probeOrigin("127.0.0.1", s.port), "reachable");
  app.instance.closeAllConnections();
  await new Promise((resolve) => app.instance.close(resolve));
  assert.equal((await probeHealth(s.url)).code, "http_error");
  assert.equal(await probeOrigin("127.0.0.1", s.port), "reachable");
  s.instance.closeAllConnections();
  await new Promise((resolve) => s.instance.close(resolve));
  assert.equal((await probeHealth(s.url)).code, "endpoint_unreachable");
  assert.equal(await probeOrigin("127.0.0.1", s.port), "unavailable");
});

test("a cached success, degraded heartbeat, invalid or oversized response cannot pass a watchdog check", async () => {
  for (const [patch, code] of [
    [{ probe: "0".repeat(32) }, "stale_response"],
    [{ monitoring: "delayed" }, "invalid_health"],
    [{ notifications: "starting" }, "invalid_health"],
    [{ release: "development" }, "invalid_health"],
  ]) {
    const result = await probeHealth(base.url, {
      transport: async (url, options) => {
        assert.equal(options.redirect, "error");
        assert.equal(options.headers.authorization, undefined);
        return new Response(
          JSON.stringify({
            status: "ok",
            release: "a".repeat(40),
            monitoring: "current",
            notifications: "current",
            probe: url.searchParams.get("probe"),
            ...patch,
          }),
        );
      },
    });
    assert.equal(result.code, code);
  }
  let cancelled = false;
  const result = await probeHealth(base.url, {
    transport: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(5000));
          },
          cancel() {
            cancelled = true;
          },
        }),
      ),
  });
  assert.equal(result.code, "invalid_health");
  assert.equal(cancelled, true);
  assert.equal(
    (
      await probeHealth(base.url, {
        transport: async () => new Response("not-json"),
      })
    ).code,
    "invalid_health",
  );
  assert.equal(
    (
      await probeHealth(base.url, {
        transport: async () => new Response("", { status: 503 }),
      })
    ).code,
    "http_error",
  );
});

test("watchdog network deadlines and cancellation return fixed diagnostics without exposing transport errors", async () => {
  const result = await probeHealth(base.url, {
    timeoutMs: 15,
    transport: async (_url, options) =>
      new Promise((_resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Fixture timeout")),
          1000,
        );
        options.signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(new Error(botToken));
          },
          { once: true },
        );
      }),
  });
  assert.deepEqual(result, {
    healthy: false,
    code: "probe_timeout",
    release: null,
  });
  assert.equal(
    await probeOrigin("127.0.0.1", 1, { signal: AbortSignal.abort() }),
    "cancelled",
  );
});

test("an unconfigured or unverified watchdog records outages without sending messages", async (t) => {
  const f = await fixture(t, false);
  await f.tick(false);
  await f.tick(false);
  let status = await f.tick(false);
  assert.equal(status.condition, "down");
  assert.equal(status.pending, 0);
  assert.equal(f.sent.length, 0);
  f.config.delivery = { ...delivery, enabled: true };
  await f.saveConfig();
  status = await f.tick(false);
  assert.equal(status.enabled, false);
  assert.equal(status.verified, false);
  assert.equal(f.sent.length, 0);
  await f.run({ action: "test" });
  status = await f.tick(false);
  assert.equal(status.enabled, true);
  assert.equal(f.sent.length, 2);
  assert.match(f.sent[1].text, /не отговаря нормално/);
});

test("watchdog streaks reset across missed checks and initial success is not a recovery alert", async (t) => {
  const f = await fixture(t);
  await f.enable();
  await f.tick(false);
  await f.tick(false);
  f.now += 180000;
  let status = await f.tick(false);
  assert.equal(status.condition, "unknown");
  assert.equal(status.failures, 1);
  await f.tick();
  status = await f.tick();
  assert.equal(status.condition, "healthy");
  assert.equal(f.sent.length, 1);
  await f.tick(false);
  await f.tick(false);
  status = await f.tick(false);
  assert.equal(status.condition, "down");
  assert.equal(f.sent.length, 2);
  for (let n = 0; n < 4; n++) await f.tick(false);
  assert.equal(f.sent.length, 2);
  assert.equal((await f.tick()).condition, "down");
  status = await f.tick();
  assert.equal(status.condition, "healthy");
  assert.equal(f.sent.length, 3);
  await f.tick();
  assert.equal(f.sent.length, 3);
  const jobs = (await f.state()).jobs.filter((job) => job.kind !== "test");
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0].incidentId, jobs[1].incidentId);
  assert.match(jobs[1].text, /Две последователни/);
});

test("watchdog retries preserve the event reference, uncertainty and a provider-required delay", async (t) => {
  const f = await fixture(t);
  await f.enable();
  const messages = [],
    results = [
      { state: "unconfirmed", code: "delivery_timeout" },
      { state: "retry", code: "rate_limited", retryAfter: 735 },
      { state: "delivered", code: "delivered", messageId: 77 },
    ];
  f.sender = async (input) => {
    messages.push(input.text);
    return results.shift();
  };
  await f.tick(false);
  await f.tick(false);
  await f.tick(false);
  let job = (await f.state()).jobs.at(-1);
  assert.equal(job.state, "retry");
  await f.tick(false);
  job = (await f.state()).jobs.at(-1);
  assert.equal(Date.parse(job.nextAttemptAt) - f.now, 735000);
  await f.tick(false);
  assert.equal(messages.length, 2);
  f.now = Date.parse(job.nextAttemptAt);
  await f.run({ healthProbe: async () => failed });
  job = (await f.state()).jobs.at(-1);
  assert.equal(job.state, "delivered");
  assert.equal(job.hadUnconfirmed, true);
  assert.equal(job.attempts, 3);
  assert.equal(new Set(messages).size, 1);
  assert.equal(job.history[0].state, "unconfirmed");
});

test("watchdog retries stop at four uncertain attempts or when the next provider delay exceeds 24 hours", async (t) => {
  const f = await fixture(t);
  f.sender = async (input) => {
    f.sent.push(input);
    return { state: "unconfirmed", code: "transport_unconfirmed" };
  };
  await f.run({ action: "test" });
  for (let n = 0; n < 3; n++) {
    const job = (await f.state()).jobs.at(-1);
    f.now = Date.parse(job.nextAttemptAt);
    await f.run({ action: "test" });
  }
  await f.run({ action: "test" });
  assert.equal(f.sent.length, 4);
  let job = (await f.state()).jobs.at(-1);
  assert.equal(job.state, "unconfirmed");
  assert.ok(job.completedAt);
  f.now += 60000;
  f.sender = async () => ({
    state: "retry",
    code: "rate_limited",
    retryAfter: 90000,
  });
  await f.run({ action: "new-test" });
  job = (await f.state()).jobs.at(-1);
  assert.equal(job.state, "failed");
  assert.equal(job.lastCode, "retry_after_deadline");
  assert.equal(job.nextAttemptAt, null);
});

test("watchdog saves the attempt before transport and recovers a result that could not be committed", async (t) => {
  const f = await fixture(t);
  let writes = 0;
  await assert.rejects(
    f.run({
      action: "test",
      persist: async (directory, state) => {
        writes++;
        if (writes === 3) throw new Error("Injected write failure");
        await writeWatchdogState(directory, state);
      },
    }),
    /Injected write/,
  );
  assert.equal(f.sent.length, 1);
  assert.equal((await f.state()).jobs[0].state, "sending");
  let status = await f.run({ action: "test" });
  assert.equal(f.sent.length, 1);
  assert.equal(status.verified, false);
  let job = (await f.state()).jobs[0];
  assert.equal(job.state, "retry");
  assert.equal(job.history[0].code, "result_not_saved");
  f.now += 60000;
  await f.run({ action: "test" });
  job = (await f.state()).jobs[0];
  assert.equal(job.state, "delivered");
  assert.equal(job.hadUnconfirmed, true);
  assert.equal(f.sent.length, 2);
  assert.equal(f.sent[0].text, f.sent[1].text);
});

test("watchdog never sends when the durable pre-dispatch save fails", async (t) => {
  const f = await fixture(t);
  let writes = 0;
  await assert.rejects(
    f.run({
      action: "test",
      persist: async (directory, state) => {
        writes++;
        if (writes === 2) throw new Error("Injected pre-dispatch failure");
        await writeWatchdogState(directory, state);
      },
    }),
    /pre-dispatch/,
  );
  assert.equal(f.sent.length, 0);
  assert.equal((await f.state()).jobs[0].state, "queued");
  await f.run({ action: "test" });
  assert.equal(f.sent.length, 1);
});

for (const result of [
  { state: "delivered", code: "delivered", messageId: 88 },
  { state: "unconfirmed", code: "transport_unconfirmed" },
])
  test(`watchdog rotation records a late ${result.state} result without verifying the new destination`, async (t) => {
    const f = await fixture(t);
    f.sender = async (input) => {
      f.sent.push(input);
      f.config.delivery.chatId = "123456";
      await f.saveConfig();
      return result;
    };
    const status = await f.run({ action: "test" });
    const job = (await f.state()).jobs[0];
    assert.equal(
      job.state,
      result.state === "delivered" ? "delivered" : "cancelled",
    );
    assert.equal(status.verified, false);
    assert.equal(status.testId, null);
    await f.tick();
    assert.equal(f.sent.length, 1);
    assert.equal(JSON.stringify(status).includes(botToken), false);
  });

test("watchdog rechecks the selected destination immediately before transport", async (t) => {
  const f = await fixture(t);
  let writes = 0;
  await f.run({
    action: "test",
    persist: async (directory, state) => {
      await writeWatchdogState(directory, state);
      if (++writes === 2) {
        f.config.delivery.chatId = "9876";
        await f.saveConfig();
      }
    },
  });
  assert.equal(f.sent.length, 0);
  const job = (await f.state()).jobs[0];
  assert.equal(job.state, "cancelled");
  assert.equal(job.history[0].code, "cancelled_before_dispatch");
});

test("a rejected watchdog destination blocks future incident delivery until another confirmed test", async (t) => {
  const f = await fixture(t);
  await f.enable();
  f.sender = async (input) => {
    f.sent.push(input);
    return { state: "rejected", code: "bot_unauthorized" };
  };
  await f.tick(false);
  await f.tick(false);
  let status = await f.tick(false);
  assert.equal(status.blockedCode, "bot_unauthorized");
  assert.equal(status.enabled, false);
  assert.equal(status.verified, false);
  await f.tick(false);
  assert.equal(f.sent.length, 2);
  await f.run({ action: "test" });
  assert.equal(f.sent.length, 2);
  f.sender = async (input) => {
    f.sent.push(input);
    return { state: "delivered", code: "delivered", messageId: 99 };
  };
  await f.run({ action: "new-test" });
  status = await f.tick(false);
  assert.equal(status.enabled, true);
  assert.equal(status.blockedCode, null);
  assert.equal(f.sent.length, 4);
});

test("recovery cancels an obsolete outage retry while retaining its uncertain result", async (t) => {
  const f = await fixture(t);
  await f.enable();
  let sends = 0;
  f.sender = async (input) => {
    f.sent.push(input);
    return ++sends === 1
      ? { state: "unconfirmed", code: "delivery_timeout" }
      : { state: "retry", code: "rate_limited", retryAfter: 600 };
  };
  await f.tick(false);
  await f.tick(false);
  await f.tick(false);
  await f.tick();
  await f.tick();
  const state = await f.state(),
    outage = state.jobs.find((job) => job.kind === "outage");
  assert.equal(state.condition, "healthy");
  assert.equal(outage.state, "cancelled");
  assert.equal(outage.hadUnconfirmed, true);
  assert.equal(outage.lastCode, "recovered_before_delivery");
  assert.equal(state.jobs.filter((job) => job.kind === "recovery").length, 1);
});

test("watchdog tests resume the same durable request, support cancellation and require an explicit new test", async (t) => {
  const f = await fixture(t);
  f.sender = async (input) => {
    f.sent.push(input);
    return { state: "unconfirmed", code: "delivery_timeout" };
  };
  const first = await f.run({ action: "test" });
  await f.run({ action: "test" });
  assert.equal(f.sent.length, 1);
  await assert.rejects(f.run({ action: "new-test" }), {
    code: "test_pending_or_cooling_down",
  });
  await f.run({ action: "cancel-test" });
  assert.equal((await f.state()).jobs[0].state, "cancelled");
  f.now += 60000;
  const next = await f.run({ action: "new-test" });
  assert.notEqual(first.testId, next.testId);
  assert.equal(f.sent.length, 2);
});

test("watchdog retention keeps pending attempts and the last test without retaining old terminal history", async (t) => {
  const f = await fixture(t);
  await f.run({ action: "test" });
  const state = await f.state(),
    original = state.jobs[0];
  for (let n = 0; n < 150; n++)
    state.jobs.push({
      ...structuredClone(original),
      id: randomUUID(),
      kind: "outage",
    });
  const pending = {
    ...structuredClone(original),
    id: randomUUID(),
    kind: "recovery",
    state: "retry",
    completedAt: null,
    nextAttemptAt: new Date(f.now + 1000).toISOString(),
  };
  state.jobs.push(pending);
  pending.history[0].state = "unconfirmed";
  pending.history[0].messageId = null;
  pending.history[0].code = "delivery_timeout";
  pending.hadUnconfirmed = true;
  pruneWatchdog(state, f.now + 31 * 86400000);
  validateWatchdogState(state);
  await writeWatchdogState(f.stateDirectory, state);
  assert.equal(state.jobs.length, 2);
  assert.equal(state.jobs[0].id, state.testId);
  assert.equal(state.jobs[1].id, pending.id);
  const status = await currentWatchdogStatus(f.file, f.stateDirectory);
  assert.equal(status.pending, 1);
  assert.equal(JSON.stringify(status).includes(botToken), false);
});

test(
  "Linux watchdog invocations serialize on the OS lock without issuing a duplicate probe",
  { skip: process.platform !== "linux", timeout: 15000 },
  async (t) => {
    const f = await fixture(t, false);
    let release, started;
    const ready = new Promise((resolve) => {
      started = resolve;
    });
    const s = await server(t, (request, response) => {
      release = () => response.end(JSON.stringify(healthBody(request)));
      started();
    });
    f.config.url = s.url;
    f.config.originPort = s.port;
    await f.saveConfig();
    const start = () => {
      const child = spawn(
        process.execPath,
        ["scripts/watchdog.mjs", "run", f.file, f.stateDirectory],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      child.stdout.resume();
      child.stderr.resume();
      const done = new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", resolve);
      });
      return { child, done };
    };
    const first = start();
    t.after(() => {
      first.child.kill("SIGTERM");
      release?.();
    });
    await ready;
    const second = start();
    assert.equal(await second.done, 75);
    release();
    assert.equal(await first.done, 0);
    assert.equal((await f.state()).lastSample.healthy, true);
  },
);

test("watchdog clock regression cannot send or overwrite the last verified sample", async (t) => {
  const f = await fixture(t);
  await f.tick();
  const before = await f.state();
  f.now -= 60000;
  await assert.rejects(f.run(), { code: "clock_regressed" });
  await assert.rejects(f.run({ action: "test" }), { code: "clock_regressed" });
  assert.deepEqual(await f.state(), before);
  assert.equal(f.sent.length, 0);
});

test("watchdog English messages and changed-target status describe the selected monitor", async (t) => {
  const f = await fixture(t);
  f.config.language = "en";
  await f.saveConfig();
  await f.enable();
  await f.tick(false);
  await f.tick(false);
  await f.tick(false);
  await f.tick();
  await f.tick();
  assert.match(f.sent[0].text, /Independent monitoring test/);
  assert.match(f.sent[1].text, /health check failed/);
  assert.match(f.sent[2].text, /Two consecutive fresh/);
  f.config.originHost = "192.0.2.20";
  await f.saveConfig();
  const status = await currentWatchdogStatus(f.file, f.stateDirectory);
  assert.equal(status.condition, "unknown");
  assert.equal(status.lastSample, null);
  assert.equal(status.verified, false);
});

test("watchdog restore quarantine cancels interrupted delivery and requires disable, fresh test and re-enable", async (t) => {
  const f = await fixture(t);
  await f.enable();
  f.now += 60000;
  let writes = 0;
  await assert.rejects(
    f.run({
      action: "new-test",
      persist: async (directory, state) => {
        if (++writes === 3) throw new Error("Injected lost result");
        await writeWatchdogState(directory, state);
      },
    }),
    /lost result/,
  );
  assert.equal((await f.state()).jobs.at(-1).state, "sending");
  const sent = f.sent.length;
  const unexpectedNetwork = async () => {
    throw new Error("Quarantine must not use transport");
  };
  let status = await f.run({
    action: "quarantine",
    healthProbe: unexpectedNetwork,
    originProbe: unexpectedNetwork,
    send: unexpectedNetwork,
  });
  assert.equal(status.quarantined, true);
  assert.equal(status.verified, false);
  assert.equal(status.pending, 0);
  const interrupted = (await f.state()).jobs.at(-1);
  assert.equal(interrupted.state, "cancelled");
  assert.equal(interrupted.hadUnconfirmed, true);
  await f.tick(false);
  await f.tick(false);
  await f.tick(false);
  assert.equal(f.sent.length, sent);
  await assert.rejects(f.run({ action: "test" }), {
    code: "disable_delivery_before_testing",
  });
  f.config.delivery.enabled = false;
  await f.saveConfig();
  status = await f.run({ action: "test" });
  assert.equal(status.quarantined, false);
  assert.equal(status.verified, true);
  assert.equal(status.enabled, false);
  f.config.delivery.enabled = true;
  await f.saveConfig();
  status = await f.tick(false);
  assert.equal(status.enabled, true);
});

test("watchdog queue limits retain an explicit failed event without losing the outage", async (t) => {
  const f = await fixture(t);
  await f.enable();
  const state = await f.state(),
    original = state.jobs[0];
  for (let index = 0; index < 100; index++) {
    const id = randomUUID();
    state.jobs.push({
      ...structuredClone(original),
      id,
      kind: "outage",
      incidentId: randomUUID(),
      text: original.text.replace(original.id, id),
      state: "queued",
      completedAt: null,
      nextAttemptAt: new Date(f.now + 6000000).toISOString(),
      attempts: 0,
      history: [],
      lastCode: null,
    });
  }
  await writeWatchdogState(f.stateDirectory, state);
  await f.tick(false);
  await f.tick(false);
  const status = await f.tick(false);
  const job = (await f.state()).jobs.at(-1);
  assert.equal(status.condition, "down");
  assert.equal(status.pending, 100);
  assert.equal(job.state, "failed");
  assert.equal(job.lastCode, "queue_limit");
  assert.equal(f.sent.length, 1);
});

test(
  "Linux watchdog shutdown drains its child and releases the OS lock",
  { skip: process.platform !== "linux", timeout: 15000 },
  async (t) => {
    const f = await fixture(t, false);
    let started,
      answer = false,
      release;
    const ready = new Promise((resolve) => {
      started = resolve;
    });
    const s = await server(t, (request, response) => {
      release = () => response.end(JSON.stringify(healthBody(request)));
      if (answer) release();
      else started();
    });
    f.config.url = s.url;
    f.config.originPort = s.port;
    await f.saveConfig();
    const start = () => {
      const child = spawn(
        process.execPath,
        ["scripts/watchdog.mjs", "run", f.file, f.stateDirectory],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      child.stdout.resume();
      child.stderr.resume();
      return {
        child,
        done: new Promise((resolve, reject) => {
          child.once("error", reject);
          child.once("exit", resolve);
        }),
      };
    };
    const first = start();
    t.after(() => {
      first.child.kill("SIGTERM");
      release?.();
    });
    await ready;
    first.child.kill("SIGTERM");
    assert.equal(await first.done, 1);
    answer = true;
    release?.();
    const second = start();
    assert.equal(await second.done, 0);
    assert.equal((await f.state()).lastSample.healthy, true);
  },
);
