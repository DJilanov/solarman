import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { createPool, migrate } from "../../src/database.mjs";
import { dashboardConfig } from "../../src/dashboard-config.mjs";
import { hashPassword, tokenHash } from "../../src/auth.mjs";
import { encryptCredentials } from "../../src/credentials.mjs";
import { AccountHub } from "../../src/account-hub.mjs";
import { createApp } from "../../src/http-app.mjs";
import { localDay } from "../../src/analytics.mjs";

let pool;
let hub;
let server;
let origin;
let alpha;
let beta;
const key = randomBytes(32);
const password = "integration-example-password";
const ids = {};

async function fetchApi(
  path,
  {
    auth,
    method = "GET",
    body,
    csrf = true,
    originHeader = true,
    idempotency,
  } = {},
) {
  const headers = {
    ...(auth ? { cookie: auth.cookie } : {}),
    ...(originHeader ? { origin: "http://localhost" } : {}),
    ...(body ? { "content-type": "application/json" } : {}),
    ...(auth && csrf ? { "x-csrf-token": auth.csrfToken } : {}),
    ...(idempotency ? { "idempotency-key": idempotency } : {}),
  };
  return fetch(`${origin}/api${path}`, {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

async function login(email) {
  const response = await fetchApi("/auth/login", {
    method: "POST",
    body: { email, password },
  });
  assert.equal(response.status, 200);
  const data = await response.json();
  return { ...data, cookie: response.headers.get("set-cookie").split(";")[0] };
}

before(async () => {
  const config = dashboardConfig(process.env);
  pool = createPool({ ...config.database, database: "solarman_test" });
  assert.equal(
    (await pool.query("SELECT current_database() AS name")).rows[0].name,
    "solarman_test",
  );
  await migrate(pool);
  await pool.query("TRUNCATE tenants CASCADE");
  const hash = await hashPassword(password);
  for (const name of ["alpha", "beta"]) {
    const tenant = randomUUID();
    const user = randomUUID();
    const account = randomUUID();
    const device = `${name}-inverter`;
    ids[name] = { tenant, user, account, device };
    await pool.query("INSERT INTO tenants (id,name) VALUES ($1,$2)", [
      tenant,
      name,
    ]);
    await pool.query(
      "INSERT INTO users (id,tenant_id,email,password_hash,platform_admin) VALUES ($1,$2,$3,$4,$5)",
      [user, tenant, `${name}@example.test`, hash, name === "alpha"],
    );
    await pool.query("INSERT INTO controller_state (tenant_id) VALUES ($1)", [
      tenant,
    ]);
    await pool.query(
      `INSERT INTO solarman_accounts (id,tenant_id,email,credentials,device_sn,discovered_devices,validated_at)
      VALUES ($1,$2,$3,$4,$5,$6,now())`,
      [
        account,
        tenant,
        `${name}-provider@example.test`,
        encryptCredentials(
          {
            passwordSha256: "a".repeat(64),
            appSecret: "private-provider-secret",
          },
          key,
          tenant,
          account,
        ),
        device,
        JSON.stringify([{ deviceSn: device, stationId: 1, stationName: name }]),
      ],
    );
    for (let offset = 1; offset <= 2; offset++) {
      await pool.query(
        `INSERT INTO measurements (tenant_id,account_id,device,observed_at,soc,temperature_c,pv_w,load_w,grid_w,battery_w,ac_enabled,snapshot)
        VALUES ($1,$2,$3,now()-($4::integer*interval '15 minutes'),70,19,$5,1000,500,-300,false,'{}')`,
        [tenant, account, device, offset, name === "alpha" ? 7109 : 2333],
      );
    }
  }
  hub = new AccountHub(
    pool,
    { SOLARMAN_APP_ID: "", SOLARMAN_APP_SECRET: "", WRITES_ENABLED: "false" },
    key,
  );
  await hub.initialize();
  const app = createApp({
    pool,
    hub,
    config: { origin: "http://localhost", secure: false },
  });
  server = createServer((req, res) => {
    void app(req, res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  alpha = await login("alpha@example.test");
  beta = await login("beta@example.test");
});

after(async () => {
  if (hub) await hub.close();
  if (server)
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeIdleConnections();
    });
  if (pool) {
    await pool.query("TRUNCATE tenants CASCADE");
    await pool.end();
  }
});

test("all data routes require a session", async () => {
  for (const path of ["/overview", "/analytics", "/activity", "/settings"])
    assert.equal((await fetchApi(path)).status, 401);
});

test("account changes serialize within a workspace without blocking another tenant", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const pending = hub.updateAccount(ids.alpha.tenant, () => gate);
  try {
    await assert.rejects(
      hub.updateAccount(ids.alpha.tenant, async () => undefined),
      /already in progress/,
    );
    assert.equal(
      await hub.updateAccount(ids.beta.tenant, async () => "separate"),
      "separate",
    );
  } finally {
    release();
    await pending;
  }
  assert.equal(
    await hub.updateAccount(ids.alpha.tenant, async () => "available"),
    "available",
  );
});

test("overview, analytics and CSV remain scoped to the signed-in workspace", async () => {
  const a = await (await fetchApi("/overview", { auth: alpha })).json();
  const b = await (await fetchApi("/overview", { auth: beta })).json();
  assert.equal(a.latest.pvW, 7109);
  assert.equal(b.latest.pvW, 2333);
  const from = localDay(Date.now() - 86400_000);
  const to = localDay(Date.now());
  const csv = await (
    await fetchApi(`/export.csv?from=${from}&to=${to}`, { auth: beta })
  ).text();
  assert.equal(csv.includes("7109"), false);
  assert.equal(csv.includes("2333"), true);
  const analytics = await (
    await fetchApi(`/analytics?from=${from}&to=${to}`, { auth: beta })
  ).json();
  assert.equal(
    analytics.points.every((point) => point.pvW === 2333),
    true,
  );
});

test("settings never return provider secrets or another workspace account", async () => {
  const response = await (await fetchApi("/settings", { auth: beta })).json();
  assert.equal(response.account.email, "beta-provider@example.test");
  const serialized = JSON.stringify(response);
  for (const forbidden of [
    "private-provider-secret",
    "a".repeat(64),
    "alpha-provider@example.test",
    "password_hash",
    "ciphertext",
  ])
    assert.equal(serialized.includes(forbidden), false);
});

test("modifying routes reject missing CSRF and a different origin", async () => {
  const options = {
    auth: beta,
    method: "POST",
    body: { action: "pause" },
    idempotency: randomUUID(),
  };
  assert.equal(
    (await fetchApi("/commands", { ...options, csrf: false })).status,
    403,
  );
  assert.equal(
    (await fetchApi("/commands", { ...options, originHeader: false })).status,
    403,
  );
});

test("command requests are idempotent and another tenant cannot retrieve the job", async () => {
  const idempotency = randomUUID();
  const options = {
    auth: alpha,
    method: "POST",
    body: { action: "pause" },
    idempotency,
  };
  const responses = await Promise.all([
    fetchApi("/commands", options),
    fetchApi("/commands", options),
  ]);
  assert.equal(
    responses.every((response) => response.status === 202),
    true,
  );
  const [one, two] = await Promise.all(
    responses.map((response) => response.json()),
  );
  assert.equal(one.id, two.id);
  assert.equal(
    (await fetchApi(`/commands/${one.id}`, { auth: beta })).status,
    404,
  );
  const rows = await pool.query(
    "SELECT count(*)::integer AS count FROM command_executions WHERE tenant_id=$1 AND idempotency_key=$2",
    [ids.alpha.tenant, idempotency],
  );
  assert.equal(rows.rows[0].count, 1);
});

test("the database refuses another tenant account or user on a record", async () => {
  await assert.rejects(
    pool.query(
      `INSERT INTO measurements
    (tenant_id,account_id,device,observed_at,soc,temperature_c,pv_w,load_w,grid_w,battery_w,ac_enabled,snapshot)
    VALUES ($1,$2,'wrong',now(),50,19,1,1,1,1,false,'{}')`,
      [ids.beta.tenant, ids.alpha.account],
    ),
    { code: "23503" },
  );
  await assert.rejects(
    pool.query(
      "INSERT INTO command_executions (id,tenant_id,user_id,actor,action,status) VALUES ($1,$2,$3,'wrong','pause','queued')",
      [randomUUID(), ids.beta.tenant, ids.alpha.user],
    ),
    { code: "23503" },
  );
});

test("a tenant cannot bind an inverter outside its discovered device list", async () => {
  const response = await fetchApi("/account/device", {
    auth: beta,
    method: "POST",
    body: { deviceSn: ids.alpha.device, profile: "monitor-only" },
  });
  assert.equal(response.status, 409);
  assert.equal(
    (
      await pool.query(
        "SELECT device_sn FROM solarman_accounts WHERE tenant_id=$1",
        [ids.beta.tenant],
      )
    ).rows[0].device_sn,
    ids.beta.device,
  );
});

test("platform administration is restricted and invitation activation is single use", async () => {
  assert.equal((await fetchApi("/admin/tenants", { auth: beta })).status, 403);
  const invite = await fetchApi("/admin/invitations", {
    auth: alpha,
    method: "POST",
    body: { email: "invited@example.test", tenantName: "Invited workspace" },
  });
  assert.equal(invite.status, 201);
  const token = new URL((await invite.json()).url).searchParams.get("token");
  const response = await fetchApi("/auth/activate", {
    method: "POST",
    body: { token, password },
  });
  assert.equal(response.status, 200);
  const session = await response.json();
  assert.equal(session.user.platformAdmin, false);
  assert.notEqual(session.tenant.id, alpha.tenant.id);
  assert.equal(
    (
      await fetchApi("/auth/activate", {
        method: "POST",
        body: { token, password },
      })
    ).status,
    400,
  );
});

test("session identifiers are hashed in PostgreSQL and logout revokes them", async () => {
  const fresh = await login("beta@example.test");
  const token = fresh.cookie.split("=")[1];
  assert.equal(
    (await pool.query("SELECT 1 FROM sessions WHERE token_hash=$1", [token]))
      .rowCount,
    0,
  );
  assert.equal(
    (
      await pool.query("SELECT 1 FROM sessions WHERE token_hash=$1", [
        tokenHash(token),
      ])
    ).rowCount,
    1,
  );
  assert.equal(
    (await fetchApi("/auth/logout", { auth: fresh, method: "POST", body: {} }))
      .status,
    200,
  );
  assert.equal((await fetchApi("/overview", { auth: fresh })).status, 401);
});
