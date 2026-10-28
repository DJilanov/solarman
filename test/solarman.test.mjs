import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  SolarmanClient,
  SolarmanAuthenticationError,
} from "../src/solarman.mjs";
import { readCommand } from "../src/modbus.mjs";

const command = readCommand(3, 206, 2);
const ack = "010304000000093A35";

async function fixture(t, handleCommand) {
  const requests = [];
  let tokens = 0;
  let order = 0;
  const server = createServer((request, response) => {
    (async () => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      response.setHeader("content-type", "application/json");
      if (request.url.startsWith("/account/v1.0/token?")) {
        tokens++;
        assert.equal(body.password, "a".repeat(64));
        assert.equal(body.appSecret, "test-secret");
        response.end(
          JSON.stringify({
            success: true,
            access_token: `token-${tokens}`,
            expires_in: "3600",
          }),
        );
        return;
      }
      if (request.url === "/account/v1.0/balance?language=en") {
        assert.equal(body.appId, "test-app");
        response.end(JSON.stringify({ success: true, total: 1000 }));
        return;
      }
      assert.equal(request.url, "/device/v1.0/customControl?language=en");
      assert.equal(body.deviceSN, "TEST-INVERTER");
      assert.equal(request.headers.authorization, `bearer token-${tokens}`);
      assert.match(body.callBackUrl, /\/solarman\/callback\/[a-f0-9]{64}$/);
      requests.push(body);
      const orderId = ++order;
      const payload = (changes = {}) => ({
        ack,
        content: body.content,
        deviceSn: body.deviceSN,
        orderId,
        success: true,
        createTime: Date.now(),
        updateTime: Date.now(),
        ...changes,
      });
      const callback = async (changes = {}) =>
        fetch(body.callBackUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload(changes)),
        });
      if (handleCommand)
        await handleCommand({
          body,
          response,
          callback,
          orderId,
          requestIndex: requests.length,
        });
      else {
        assert.equal(await (await callback()).text(), "SUCCESS");
        response.end(JSON.stringify({ success: true, orderId }));
      }
    })().catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end(JSON.stringify({ success: false }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const config = {
    appId: "test-app",
    appSecret: "test-secret",
    email: "owner@example.com",
    passwordSha256: "a".repeat(64),
    deviceSN: "TEST-INVERTER",
    commandTimeoutMs: 50,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    callbackOrigin: "",
  };
  const client = new SolarmanClient(config, { minGapMs: 0 });
  await client.listen(0, "127.0.0.1");
  config.callbackOrigin = `http://127.0.0.1:${client.server.address().port}`;
  t.after(async () => {
    await client.close();
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeIdleConnections();
    });
  });
  return { client, requests, tokenCount: () => tokens };
}

test("supports a callback arriving before the HTTP submission response, and caches tokens", async (t) => {
  const { client, requests, tokenCount } = await fixture(t);
  assert.deepEqual(
    await Promise.all([client.command(command), client.command(command)]),
    [ack, ack],
  );
  assert.equal(requests.length, 2);
  assert.equal(tokenCount(), 1);
  assert.notEqual(requests[0].callBackUrl, requests[1].callBackUrl);
});

test("command authorization is rechecked after pacing and quota reservation, before HTTP dispatch", async (t) => {
  const { client, requests } = await fixture(t);
  let reserved = false;
  let allowed = false;
  client.onRequest = async (kind) => {
    if (kind === "command") reserved = true;
  };
  client.authorizeCommand = async (raw) => {
    assert.equal(raw, command);
    assert.equal(reserved, true);
    if (!allowed) throw new Error("Workspace suspended");
  };
  await assert.rejects(client.command(command), /Workspace suspended/);
  assert.equal(requests.length, 0);
  assert.equal(client.pending.size, 0);
  allowed = true;
  assert.equal(await client.command(command), ack);
  assert.equal(requests.length, 1);
});

test("rejects wrong device, wrong request and stale callbacks before accepting a valid result", async (t) => {
  const { client } = await fixture(
    t,
    async ({ response, callback, orderId }) => {
      assert.equal(
        (await callback({ deviceSn: "OTHER-INVERTER" })).status,
        403,
      );
      assert.equal(
        (await callback({ content: readCommand(3, 3036, 1) })).status,
        403,
      );
      assert.equal(
        (
          await callback({
            createTime: Date.now() - 120_000,
            updateTime: Date.now() - 120_000,
          })
        ).status,
        400,
      );
      assert.equal(await (await callback()).text(), "SUCCESS");
      assert.equal(await (await callback()).text(), "SUCCESS");
      response.end(JSON.stringify({ success: true, orderId }));
    },
  );
  assert.equal(await client.command(command), ack);
});

test("HTTP success cannot hide a corrupt device reply; next command can still run", async (t) => {
  const { client } = await fixture(
    t,
    async ({ response, callback, orderId, requestIndex }) => {
      await callback({ ack: requestIndex === 1 ? "010304000000093A34" : ack });
      response.end(JSON.stringify({ success: true, orderId }));
    },
  );
  await assert.rejects(client.command(command), /CRC/);
  assert.equal(await client.command(command), ack);
});

test("rejects callback failure and mismatched order ID", async (t) => {
  const { client } = await fixture(
    t,
    async ({ response, callback, orderId, requestIndex }) => {
      await callback(
        requestIndex === 1 ? { success: false, errorCode: "573" } : {},
      );
      response.end(JSON.stringify({ success: true, orderId: orderId + 100 }));
    },
  );
  await assert.rejects(client.command(command), /573/);
  await assert.rejects(client.command(command), /order ID/);
});

test("refreshes invalidated authentication on the next command without retrying a submission", async (t) => {
  const { client, requests, tokenCount } = await fixture(
    t,
    async ({ response, callback, orderId, requestIndex }) => {
      if (requestIndex === 1) {
        response.end(
          JSON.stringify({
            success: false,
            code: "2101019",
            msg: "must not appear in errors",
          }),
        );
      } else {
        await callback();
        response.end(JSON.stringify({ success: true, orderId }));
      }
    },
  );
  await assert.rejects(client.command(command), /2101019/);
  assert.equal(requests.length, 1);
  assert.equal(await client.command(command), ack);
  assert.equal(tokenCount(), 2);
});

test("does not retry an ambiguous HTTP failure or expose response bodies", async (t) => {
  const { client, requests } = await fixture(t, async ({ response }) => {
    response.writeHead(500);
    response.end(JSON.stringify({ message: "private response detail" }));
  });
  await assert.rejects(client.command(command), {
    message: "SOLARMAN HTTP status 500",
  });
  assert.equal(requests.length, 1);
});

test("submission acceptance alone times out without a device callback", async (t) => {
  const { client, requests } = await fixture(
    t,
    async ({ response, orderId }) => {
      response.end(JSON.stringify({ success: true, orderId }));
    },
  );
  await assert.rejects(client.command(command), /outcome is unknown/);
  assert.equal(requests.length, 1);
});

test("shared request pacing includes token creation as well as each command", async (t) => {
  const { client } = await fixture(t);
  let reservations = 0;
  client.beforeRequest = async () => {
    reservations++;
  };
  await client.command(command);
  await client.command(command);
  assert.equal(reservations, 3);
});

test("a denied routine reservation sends no HTTP request; recovery includes authentication", async (t) => {
  const { client, tokenCount, requests } = await fixture(t);
  const purposes = [];
  client.onRequest = async (kind, purpose) => {
    if (purpose !== "recovery") throw new Error("Routine allowance used");
    purposes.push({ kind, purpose });
  };
  await assert.rejects(client.command(command), /Routine allowance used/);
  assert.equal(tokenCount(), 0);
  assert.equal(requests.length, 0);
  assert.equal(await client.command(command, { purpose: "recovery" }), ack);
  assert.deepEqual(purposes, [
    { kind: "token", purpose: "recovery" },
    { kind: "command", purpose: "recovery" },
  ]);
});

test("the documented balance endpoint uses its distinct bounded probe allowance", async (t) => {
  const { client } = await fixture(t);
  const purposes = [];
  client.onRequest = async (kind, purpose) => {
    purposes.push({ kind, purpose });
  };
  assert.equal(
    (await client.api("/account/v1.0/balance", { appId: "test-app" })).total,
    1000,
  );
  assert.deepEqual(purposes, [
    { kind: "token", purpose: "balance" },
    { kind: "read", purpose: "balance" },
  ]);
});

test("authentication incidents require an explicit provider rejection rather than a malformed response", async (t) => {
  const { client } = await fixture(t);
  for (const [body, status, rejected] of [
    [{ success: false, code: "2101003" }, 200, true],
    [{ code: "2101003" }, 200, false],
    [null, 200, false],
    [{}, 401, true],
    [{}, 503, false],
  ]) {
    t.mock.method(
      globalThis,
      "fetch",
      async () => new Response(JSON.stringify(body), { status }),
    );
    await assert.rejects(client.post("/account/v1.0/token", {}), (error) => {
      assert.equal(error instanceof SolarmanAuthenticationError, rejected);
      return true;
    });
    t.mock.restoreAll();
  }
});
