import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createPool, migrate } from "../../src/database.mjs";
import { dashboardConfig } from "../../src/dashboard-config.mjs";
import { hashPassword, tokenHash } from "../../src/auth.mjs";
import { encryptCredentials } from "../../src/credentials.mjs";
import { AccountHub } from "../../src/account-hub.mjs";
import { createApp } from "../../src/http-app.mjs";
import { localDay } from "../../src/analytics.mjs";
import { TenantRuntime } from "../../src/tenant-runtime.mjs";
import { decide } from "../../src/controller.mjs";
import { providerPayload } from "../fixtures/provider.mjs";
import { ApiBudget, ApiBudgetError, apiAppKey } from "../../src/api-budget.mjs";
import { ControlJournal } from "../../src/control-journal.mjs";
import { parseFrame, frame } from "../../src/modbus.mjs";
import { Operations } from "../../src/operations.mjs";

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
  await pool.query("TRUNCATE api_app_budgets,tenants CASCADE");
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
    await pool.query("TRUNCATE api_app_budgets,tenants CASCADE");
    await pool.end();
  }
});

test("all data routes require a session", async () => {
  for (const path of [
    "/overview",
    "/analytics",
    "/activity",
    "/settings",
    "/write-history",
    "/operations",
    `/activity/${randomUUID()}`,
  ])
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

async function controlFixture(writes = false) {
  await pool.query("DELETE FROM operational_incidents WHERE tenant_id=$1", [
    ids.alpha.tenant,
  ]);
  await pool.query("DELETE FROM device_health WHERE tenant_id=$1", [
    ids.alpha.tenant,
  ]);
  await pool.query("DELETE FROM inverter_write_intents WHERE tenant_id=$1", [
    ids.alpha.tenant,
  ]);
  await pool.query("DELETE FROM device_control_state WHERE tenant_id=$1", [
    ids.alpha.tenant,
  ]);
  await pool.query(
    "UPDATE solarman_accounts SET profile='bluesun-bse20kh3' WHERE tenant_id=$1",
    [ids.alpha.tenant],
  );
  await pool.query(
    "UPDATE controller_state SET paused=true,manual_topup=false,control_enabled=false,verification=null,topup_expires_at=null WHERE tenant_id=$1",
    [ids.alpha.tenant],
  );
  const row = (
    await pool.query("SELECT * FROM solarman_accounts WHERE tenant_id=$1", [
      ids.alpha.tenant,
    ])
  ).rows[0];
  const runtime = new TenantRuntime(
    {
      pool,
      key,
      stopping: false,
      env: {
        SOLARMAN_APP_ID: "fixture-app",
        SOLARMAN_APP_SECRET: "fixture-secret",
        CALLBACK_PUBLIC_URL: "https://fixture.example.test",
        WRITES_ENABLED: String(writes),
      },
      reserveRequest: async () => {},
      budget: new ApiBudget(pool, {}),
      monitorPollMs: (runtime) => runtime.monitorPollMs,
      runLimited: async (operation) => operation(),
    },
    ids.alpha.tenant,
    { ...row, profile: "bluesun-bse20kh3" },
  );
  await runtime.initialize();
  const snapshot = {
    flags: 9,
    mode: 0,
    acPowerRaw: 100,
    acTargetRaw: 500,
    windows: [0, 5947, 0, 0, 0, 0, 0, 0],
    batteryState: 6,
    soc: 30,
    batteryW: -1942,
    temperatureC: 16,
    pvW: 3500,
    loadW: 1000,
    gridW: 0,
    gridVoltages: [230, 230, 230],
  };
  const calls = [];
  runtime.client.api = async (path, body) => {
    if (path === "/account/v1.0/balance")
      return { success: true, total: 200000 };
    assert.equal(path, "/device/v1.0/currentData");
    assert.equal(body.deviceSn, runtime.device);
    calls.push("provider-read");
    return providerPayload({
      device: runtime.device,
      values: {
        PVTP: String(snapshot.pvW),
        EP: String(snapshot.loadW),
        PG_Pt1: String(snapshot.gridW),
        B_P1: String(snapshot.batteryW),
        B_left_cap1: String(snapshot.soc),
        B_T1: String(snapshot.temperatureC),
      },
    });
  };
  runtime.inspector = {
    read: async (fn, address, count) => {
      assert.deepEqual([fn, address, count], [4, 7, 2]);
      calls.push("rated-read");
      return [0, 20000];
    },
    snapshot: async () => structuredClone(snapshot),
    settings: async () => ({ maximumSoc: 100, reserveSoc: 50 }),
  };
  runtime.controller.disable = async () => {
    calls.push("disable");
    return 9;
  };
  runtime.controller.tick = async () => {
    calls.push("tick");
    return { snapshot: structuredClone(snapshot), decision: decide(snapshot) };
  };
  return {
    runtime,
    snapshot,
    calls,
    user: {
      tenant_id: ids.alpha.tenant,
      id: ids.alpha.user,
      email: "alpha@example.test",
    },
  };
}

async function completeCommand(runtime, action, user) {
  const job = await runtime.submit(action, user, randomUUID());
  await runtime.work.idle();
  return (
    await pool.query(
      "SELECT * FROM command_executions WHERE tenant_id=$1 AND id=$2",
      [runtime.tenantId, job.id],
    )
  ).rows[0];
}

test("read-only verification persists checked values but cannot enable control without host permission", async () => {
  const { runtime, calls, user } = await controlFixture();
  try {
    const job = await completeCommand(runtime, "verify", user);
    assert.equal(job.status, "succeeded");
    const history = await (
      await fetchApi(`/activity/${job.id}`, { auth: alpha })
    ).json();
    assert.equal(history.evidence.verification.checks.length, 8);
    assert.equal(history.evidence.verification.passed, true);
    assert.equal(history.device, runtime.device);
    assert.deepEqual(history.writes, []);
    assert.equal(runtime.status().control.verification.passed, true);
    assert.equal(runtime.status().control.verification.checks.length, 8);
    assert.equal(runtime.status().control.canEnable, false);
    assert.equal(
      (await completeCommand(runtime, "enable_controls", user)).status,
      "failed",
    );
    assert.equal(
      (
        await pool.query(
          "SELECT control_enabled FROM controller_state WHERE tenant_id=$1",
          [ids.alpha.tenant],
        )
      ).rows[0].control_enabled,
      false,
    );
    assert.deepEqual(calls, ["rated-read", "provider-read"]);
  } finally {
    await runtime.close();
  }
});

test("enabling one verified workspace leaves it paused and does not enable another tenant", async () => {
  const { runtime, user } = await controlFixture(true);
  try {
    await completeCommand(runtime, "verify", user);
    const job = await completeCommand(runtime, "enable_controls", user);
    assert.equal(job.status, "succeeded");
    assert.equal(runtime.controlEnabled, true);
    assert.equal(runtime.paused, true);
    assert.equal(runtime.status().writesEnabled, true);
    assert.equal(
      (
        await pool.query(
          "SELECT control_enabled FROM controller_state WHERE tenant_id=$1",
          [ids.beta.tenant],
        )
      ).rows[0].control_enabled,
      false,
    );
  } finally {
    await runtime.close();
  }
});

test("stale device verification cannot arm a workspace", async () => {
  const { runtime, user } = await controlFixture(true);
  try {
    await completeCommand(runtime, "verify", user);
    runtime.verification.checkedAt = new Date(
      Date.now() - 31 * 60_000,
    ).toISOString();
    assert.equal(runtime.status().control.canEnable, false);
    assert.equal(
      (await completeCommand(runtime, "enable_controls", user)).status,
      "failed",
    );
    assert.equal(runtime.controlEnabled, false);
  } finally {
    await runtime.close();
  }
});

test("stop persists immediately, jumps the queue and cancels an older pending top-up", async () => {
  const { runtime, user, calls } = await controlFixture(true);
  let release;
  try {
    await completeCommand(runtime, "verify", user);
    await completeCommand(runtime, "enable_controls", user);
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const running = runtime.queue(async () => {
      await gate;
    });
    const topup = await runtime.submit("topup", user, randomUUID());
    const stop = await runtime.submit("stop", user, randomUUID());
    assert.equal(runtime.controller.options.isStopping(), true);
    const intent = (
      await pool.query(
        "SELECT paused,manual_topup FROM controller_state WHERE tenant_id=$1",
        [ids.alpha.tenant],
      )
    ).rows[0];
    assert.deepEqual(intent, { paused: true, manual_topup: false });
    release();
    await running;
    await runtime.work.idle();
    const jobs = (
      await pool.query(
        "SELECT id,status FROM command_executions WHERE tenant_id=$1 AND id=ANY($2::uuid[])",
        [ids.alpha.tenant, [topup.id, stop.id]],
      )
    ).rows;
    assert.equal(jobs.find((j) => j.id === topup.id).status, "interrupted");
    assert.equal(jobs.find((j) => j.id === stop.id).status, "succeeded");
    assert.equal(calls.includes("tick"), false);
  } finally {
    release?.();
    await runtime.close();
  }
});

test("solar surplus waits within a one-time top-up and reaching 50% completes it", async () => {
  const { runtime, user, snapshot } = await controlFixture(true);
  try {
    await completeCommand(runtime, "verify", user);
    await completeCommand(runtime, "enable_controls", user);
    assert.equal(
      (await completeCommand(runtime, "topup", user)).status,
      "succeeded",
    );
    assert.equal(runtime.manualTopup, true);
    await runtime.initialize();
    assert.equal(runtime.manualTopup, true);
    assert.ok(runtime.topupExpiresAt);
    snapshot.pvW = 0;
    snapshot.gridVoltages = [0, 0, 0];
    await runtime.evaluate();
    assert.equal(runtime.manualTopup, true);
    snapshot.gridVoltages = [230, 230, 230];
    snapshot.soc = 50;
    await runtime.evaluate();
    assert.equal(runtime.manualTopup, false);
    assert.equal(runtime.topupExpiresAt, null);
  } finally {
    await runtime.close();
  }
});

test("a slow top-up submission cannot escape a newer stop request", async () => {
  const { runtime, user, calls } = await controlFixture(true);
  let release;
  try {
    await completeCommand(runtime, "verify", user);
    await completeCommand(runtime, "enable_controls", user);
    let inserted;
    const started = new Promise((resolve) => {
      inserted = resolve;
    });
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const originalQuery = runtime.q.bind(runtime);
    runtime.q = async (sql, values = []) => {
      const result = await originalQuery(sql, values);
      if (
        sql.includes("INSERT INTO command_executions") &&
        values[4] === "topup"
      ) {
        inserted();
        await gate;
      }
      return result;
    };
    const pending = runtime.submit("topup", user, randomUUID());
    await started;
    await completeCommand(runtime, "stop", user);
    release();
    const job = await pending;
    await runtime.work.idle();
    assert.equal(
      (
        await pool.query(
          "SELECT status FROM command_executions WHERE tenant_id=$1 AND id=$2",
          [runtime.tenantId, job.id],
        )
      ).rows[0].status,
      "interrupted",
    );
    assert.equal(calls.includes("tick"), false);
  } finally {
    release?.();
    await runtime.close();
  }
});

test("simultaneous retries of a stop dispatch cleanup exactly once", async () => {
  const { runtime, user, calls } = await controlFixture(true);
  try {
    await completeCommand(runtime, "verify", user);
    await completeCommand(runtime, "enable_controls", user);
    const originalQuery = runtime.q.bind(runtime);
    let release;
    let selected = 0;
    const barrier = new Promise((resolve) => {
      release = resolve;
    });
    runtime.q = async (sql, values = []) => {
      const result = await originalQuery(sql, values);
      if (sql.startsWith("SELECT * FROM command_executions")) {
        selected++;
        if (selected === 2) release();
        await barrier;
      }
      return result;
    };
    const idempotency = randomUUID();
    const jobs = await Promise.all([
      runtime.submit("stop", user, idempotency),
      runtime.submit("stop", user, idempotency),
    ]);
    assert.equal(jobs[0].id, jobs[1].id);
    await runtime.work.idle();
    assert.equal(calls.filter((call) => call === "disable").length, 1);
  } finally {
    await runtime.close();
  }
});

test("an expired top-up cannot silently restart after the service resumes", async () => {
  const { runtime, calls, user } = await controlFixture(true);
  try {
    await completeCommand(runtime, "verify", user);
    await completeCommand(runtime, "enable_controls", user);
    await pool.query(
      "UPDATE controller_state SET manual_topup=true,topup_expires_at=now()-interval '1 minute' WHERE tenant_id=$1",
      [ids.alpha.tenant],
    );
    await runtime.evaluate();
    assert.equal(runtime.manualTopup, false);
    assert.equal(calls.includes("tick"), false);
    assert.equal(calls.includes("disable"), true);
  } finally {
    await runtime.close();
  }
});

test("paused monitoring retries an unconfirmed stop before fetching new uploads", async () => {
  const { runtime, user, calls } = await controlFixture(true);
  try {
    await completeCommand(runtime, "verify", user);
    await completeCommand(runtime, "enable_controls", user);
    runtime.controller.disable = async () => {
      throw new Error("Inverter temporarily unreachable");
    };
    assert.equal(
      (await completeCommand(runtime, "stop", user)).status,
      "failed",
    );
    assert.equal(runtime.cleanupRequired, true);
    assert.equal(runtime.status().control.canStart, false);
    assert.equal(runtime.status().control.canStop, true);
    runtime.controller.disable = async () => {
      calls.push("cleanup-recovered");
      return 9;
    };
    await runtime.collect();
    assert.equal(runtime.cleanupRequired, false);
    assert.equal(runtime.paused, true);
    assert.equal(calls.includes("tick"), false);
    assert.equal(calls.includes("cleanup-recovered"), true);
  } finally {
    await runtime.close();
  }
});

test("shutdown during command acceptance leaves a terminal audit record", async () => {
  for (const action of ["refresh", "stop"]) {
    const { runtime, user } = await controlFixture();
    const originalQuery = runtime.q.bind(runtime);
    try {
      runtime.q = async (sql, values = []) => {
        const result = await originalQuery(sql, values);
        if (sql.includes("INSERT INTO command_executions"))
          runtime.stopping = true;
        return result;
      };
      runtime.journal.requestCleanup = async () => {
        assert.fail("A closed runtime must not change control ownership");
      };
      const job = await runtime.submit(action, user, randomUUID());
      assert.equal(job.status, "interrupted");
      assert.equal(runtime.scheduled.has(job.id), false);
    } finally {
      await runtime.close();
    }
  }
});

test("single-request monitoring preserves collection time and deduplicates cached uploads", async () => {
  const { runtime } = await controlFixture();
  try {
    const collectedAt = Math.floor((Date.now() - 120_000) / 1000) * 1000;
    const body = providerPayload({ device: runtime.device, collectedAt });
    let requests = 0;
    runtime.client.api = async () => {
      requests++;
      return structuredClone(body);
    };
    runtime.inspector.snapshot = async () => {
      throw new Error("Unexpected diagnostic polling");
    };
    assert.equal(
      (await runtime.collect()).decision.reason,
      "telemetry_updated",
    );
    assert.equal(
      (await runtime.collect()).decision.reason,
      "telemetry_unchanged",
    );
    assert.equal(requests, 2);
    const rows = (
      await pool.query(
        "SELECT observed_at,received_at,reading_source,sampling_seconds,ac_enabled,soc FROM measurements WHERE tenant_id=$1 AND device=$2 AND observed_at=$3",
        [runtime.tenantId, runtime.device, new Date(collectedAt)],
      )
    ).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].observed_at.getTime(), collectedAt);
    assert.ok(rows[0].received_at.getTime() > collectedAt);
    assert.equal(rows[0].reading_source, "provider");
    assert.equal(rows[0].sampling_seconds, 300);
    assert.equal(rows[0].ac_enabled, null);
    assert.equal(runtime.lastSuccessAt, new Date(collectedAt).toISOString());
    assert.equal(runtime.status().pollSeconds, 300);
    assert.equal(runtime.status().annualProjectedCalls, 105120);
    body.deviceState = 3;
    body.collectionTime += 60;
    await assert.rejects(runtime.collect(), /offline|alarm/);
    assert.equal(runtime.telemetry.deviceState, 3);
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::integer AS count FROM measurements WHERE tenant_id=$1 AND device=$2 AND observed_at=$3",
          [
            runtime.tenantId,
            runtime.device,
            new Date(body.collectionTime * 1000),
          ],
        )
      ).rows[0].count,
      0,
    );
  } finally {
    await runtime.close();
  }
});

test("diagnostic refresh cannot bypass a failed inverter clock check", async () => {
  const { runtime, user } = await controlFixture(true);
  try {
    runtime.client.api = async () =>
      providerPayload({
        device: runtime.device,
        values: { SYSTIM1: "2000-01-01 00:00:00" },
      });
    const report = await runtime.verifyDevice();
    assert.equal(report.passed, false);
    assert.equal(
      report.checks.find((check) => check.label === "Inverter clock difference")
        .passed,
      false,
    );
    await runtime.collect(true);
    assert.equal(runtime.profileVerified, true);
    assert.equal(runtime.status().control.canEnable, false);
    assert.equal(
      (await completeCommand(runtime, "enable_controls", user)).status,
      "failed",
    );
    assert.equal(runtime.controlEnabled, false);
  } finally {
    await runtime.close();
  }
});

async function quotaFixture(limit = 100, reserve = 10) {
  const appKey = apiAppKey(randomUUID());
  const budget = new ApiBudget(pool, {
    SOLARMAN_API_CALL_LIMIT: String(limit),
    SOLARMAN_API_RECOVERY_RESERVE: String(reserve),
  });
  for (const owner of [ids.alpha, ids.beta])
    await budget.register(appKey, owner.tenant, owner.account);
  const request = (owner = ids.alpha, purpose = "routine", kind = "read") => ({
    appKey,
    tenantId: owner.tenant,
    accountId: owner.account,
    kind,
    purpose,
  });
  return { appKey, budget, request };
}

test("tenants sharing an App ID cannot overspend concurrently or consume the recovery reserve", async () => {
  const { appKey, budget, request } = await quotaFixture(10, 3);
  const reservations = await Promise.allSettled(
    Array.from({ length: 12 }, (_, i) =>
      budget.reserve(request(i % 2 ? ids.alpha : ids.beta)),
    ),
  );
  assert.equal(
    reservations.filter((result) => result.status === "fulfilled").length,
    7,
  );
  for (const result of reservations.filter(
    (result) => result.status === "rejected",
  ))
    assert.ok(result.reason instanceof ApiBudgetError);
  assert.equal((await budget.status(appKey)).state, "recovery-only");
  const restored = new ApiBudget(pool, {
    SOLARMAN_API_CALL_LIMIT: "10",
    SOLARMAN_API_RECOVERY_RESERVE: "3",
  });
  assert.equal((await restored.status(appKey)).tracked, 7);
  const recovery = await Promise.allSettled(
    Array.from({ length: 5 }, () =>
      restored.reserve(request(ids.beta, "recovery", "command")),
    ),
  );
  assert.equal(
    recovery.filter((result) => result.status === "fulfilled").length,
    3,
  );
  assert.equal((await restored.status(appKey)).state, "exhausted");
  assert.equal((await restored.status(appKey)).tracked, 10);
  const separate = await quotaFixture(10, 3);
  await separate.budget.reserve(separate.request());
  assert.equal(
    (await separate.budget.status(separate.appKey)).routineRemaining,
    6,
  );
});

test("provider balance synchronization counts concurrent requests and survives a service restart", async () => {
  const { appKey, budget, request } = await quotaFixture();
  await budget.reserve(request());
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let queries = 0;
  const client = {
    config: { appId: "fixture-balance" },
    api: async (path, body) => {
      queries++;
      assert.equal(path, "/account/v1.0/balance");
      assert.equal(body.appId, "fixture-balance");
      await budget.reserve(request(ids.alpha, "balance"));
      await gate;
      return { total: 20 };
    },
  };
  const first = budget.refreshBalance(appKey, client);
  const second = budget.refreshBalance(appKey, client);
  while (queries === 0) await new Promise((resolve) => setTimeout(resolve, 5));
  await budget.reserve(request(ids.beta));
  release();
  await Promise.all([first, second]);
  const status = await budget.status(appKey);
  assert.equal(queries, 1);
  assert.equal(status.providerRemaining, 17);
  assert.equal(status.routineRemaining, 7);
  assert.equal(status.tracked, 3);
  await budget.refreshBalance(appKey, client);
  assert.equal(queries, 1);
  await budget.reserve(request(ids.beta));
  assert.equal(
    (await new ApiBudget(pool, {}).status(appKey)).providerRemaining,
    16,
  );
  assert.ok(status.providerCheckedAt);
});

test("balance probes can discover replenished provider capacity but have a two-call daily ceiling", async () => {
  const { appKey, budget, request } = await quotaFixture();
  await pool.query(
    "UPDATE api_app_budgets SET provider_remaining=0 WHERE app_key=$1",
    [appKey],
  );
  await assert.rejects(budget.reserve(request()), ApiBudgetError);
  const client = {
    config: { appId: "fixture-balance" },
    api: async () => {
      await budget.reserve(request(ids.alpha, "balance", "token"));
      await budget.reserve(request(ids.alpha, "balance", "read"));
      await assert.rejects(
        budget.reserve(request(ids.beta, "balance")),
        ApiBudgetError,
      );
      return { total: 50 };
    },
  };
  await budget.refreshBalance(appKey, client);
  assert.equal((await budget.status(appKey)).providerRemaining, 48);
  await budget.reserve(request());
  assert.equal((await budget.status(appKey)).providerRemaining, 47);
  await assert.rejects(
    budget.reserve(request(ids.alpha, "balance")),
    ApiBudgetError,
  );
});

test("old requests age out and failed balance checks never erase the last known balance", async () => {
  const { appKey, budget, request } = await quotaFixture();
  await budget.reserve(request());
  await pool.query(
    "UPDATE api_requests SET created_at=now()-interval '366 days' WHERE app_key=$1",
    [appKey],
  );
  await pool.query(
    "UPDATE api_app_budgets SET provider_remaining=12,provider_checked_at=now()-interval '2 days' WHERE app_key=$1",
    [appKey],
  );
  await budget.refreshBalance(appKey, {
    config: { appId: "fixture-balance" },
    api: async () => {
      throw new Error("Unavailable");
    },
  });
  const status = await budget.status(appKey);
  assert.equal(status.tracked, 0);
  assert.equal(status.providerRemaining, 12);
  assert.ok(status.balanceAttemptedAt > status.providerCheckedAt);
  const text = JSON.stringify(status);
  assert.equal(text.includes(appKey), false);
  assert.equal(text.includes(ids.beta.account), false);
});

test("a quota failure pauses automation once and preserves the remaining recovery allowance", async () => {
  const { runtime, user, calls } = await controlFixture(true);
  try {
    await completeCommand(runtime, "verify", user);
    await completeCommand(runtime, "enable_controls", user);
    runtime.controller.tick = async () => {
      throw new ApiBudgetError("recovery-only");
    };
    const result = await completeCommand(runtime, "resume", user);
    assert.equal(result.status, "failed");
    assert.equal(runtime.paused, true);
    assert.equal(runtime.cleanupRequired, false);
    assert.equal(calls.filter((call) => call === "disable").length, 1);
    runtime.client.api = async () => {
      throw new ApiBudgetError("recovery-only");
    };
    await runtime.evaluate();
    assert.equal(calls.filter((call) => call === "disable").length, 1);
    assert.equal(
      (
        await pool.query(
          "SELECT paused FROM controller_state WHERE tenant_id=$1",
          [runtime.tenantId],
        )
      ).rows[0].paused,
      true,
    );
  } finally {
    await runtime.close();
  }
});

test("a diagnostic request that reaches the budget limit also cleans up active automation", async () => {
  const { runtime, user, calls } = await controlFixture(true);
  try {
    await completeCommand(runtime, "verify", user);
    await completeCommand(runtime, "enable_controls", user);
    assert.equal(
      (await completeCommand(runtime, "resume", user)).status,
      "succeeded",
    );
    runtime.inspector.snapshot = async () => {
      throw new ApiBudgetError("recovery-only");
    };
    assert.equal(
      (await completeCommand(runtime, "refresh", user)).status,
      "failed",
    );
    assert.equal(runtime.paused, true);
    assert.equal(runtime.cleanupRequired, false);
    assert.equal(calls.filter((call) => call === "disable").length, 1);
  } finally {
    await runtime.close();
  }
});

async function armedFixture() {
  const fixture = await controlFixture(true);
  await completeCommand(fixture.runtime, "verify", fixture.user);
  await completeCommand(fixture.runtime, "enable_controls", fixture.user);
  await completeCommand(fixture.runtime, "resume", fixture.user);
  return fixture;
}

test("prepared writes survive a crash and cleanup never invents a successful original readback", async () => {
  const { runtime } = await armedFixture();
  try {
    const id = await runtime.journal.prepare(206, [0, 25], null);
    const restarted = new ControlJournal(pool, runtime.journal.context);
    await restarted.load(true);
    assert.equal(restarted.pending, true);
    assert.equal(restarted.status().writes[0].status, "prepared");
    assert.equal(await restarted.confirmOff(25), false);
    assert.equal(restarted.pending, true);
    assert.equal(await restarted.confirmOff(9), true);
    const row = (
      await pool.query(
        "SELECT status,verified_at,reconciled_at FROM inverter_write_intents WHERE id=$1",
        [id],
      )
    ).rows[0];
    assert.equal(row.status, "uncertain");
    assert.equal(row.verified_at, null);
    assert.ok(row.reconciled_at);
  } finally {
    await runtime.close();
  }
});

test("a stop arriving during a window write remains pending after its late confirmation", async () => {
  const { runtime } = await armedFixture();
  try {
    const id = await runtime.journal.prepare(
      2509,
      [0x1000, 0x1019, 0, 0, 0, 0, 0, 0],
      null,
    );
    await runtime.journal.acknowledge(id);
    await runtime.journal.requestCleanup({ pause: true });
    await runtime.journal.verify(id);
    assert.equal(runtime.journal.pending, true);
    await assert.rejects(
      runtime.journal.prepare(206, [0, 25], null),
      /current workspace state/,
    );
    const row = (
      await pool.query(
        "SELECT status,acknowledged_at,verified_at FROM inverter_write_intents WHERE id=$1",
        [id],
      )
    ).rows[0];
    assert.equal(row.status, "verified");
    assert.ok(row.acknowledged_at && row.verified_at);
    await runtime.journal.confirmOff(9);
  } finally {
    await runtime.close();
  }
});

test("revoking activation retains recovery authority for the same inverter only", async () => {
  const { runtime } = await armedFixture();
  let restarted;
  try {
    await runtime.journal.prepare(206, [0, 25], null);
    await pool.query(
      "UPDATE controller_state SET paused=true,control_enabled=false,verification=null WHERE tenant_id=$1",
      [runtime.tenantId],
    );
    const account = (
      await pool.query("SELECT * FROM solarman_accounts WHERE tenant_id=$1", [
        runtime.tenantId,
      ])
    ).rows[0];
    restarted = new TenantRuntime(runtime.hub, runtime.tenantId, account);
    await restarted.initialize();
    assert.equal(restarted.journal.pending, true);
    assert.equal(restarted.controller.options.writesEnabled, true);
    assert.equal(restarted.status().control.canStart, false);
    restarted.controller.disable = async () => 9;
    restarted.client.api = async () =>
      providerPayload({ device: restarted.device });
    await restarted.collect();
    assert.equal(restarted.journal.pending, false);
    assert.equal(restarted.controlEnabled, false);
    assert.equal(restarted.status().control.canStart, false);
  } finally {
    await restarted?.close();
    await runtime.close();
  }
});

test("credential repair preserves the cleanup target through discovery without rearming controls", async (t) => {
  t.mock.method(TenantRuntime.prototype, "start", () => {});
  const { runtime } = await armedFixture();
  const maintenance = new AccountHub(pool, runtime.hub.env, key);
  maintenance.runtimes.set(runtime.tenantId, runtime);
  try {
    const id = await runtime.journal.prepare(206, [0, 25], null);
    runtime.controller.disable = async () => {
      throw new Error("Previous credentials no longer work");
    };
    const linked = await maintenance.updateAccount(runtime.tenantId, () =>
      maintenance.connect(runtime.tenantId, {
        email: runtime.account.email,
        password: "fixture-updated-password",
        appId: "fixture-app",
        appSecret: "fixture-secret",
      }),
    );
    assert.equal(linked.ready, false);
    assert.equal(linked.controlEnabled, false);
    assert.equal(linked.journal.pending, true);
    assert.equal(linked.device, runtime.device);
    linked.client.api = async (path) =>
      path === "/station/v1.0/list"
        ? { total: 1, stationList: [{ id: 1, name: "Fixture plant" }] }
        : {
            total: 1,
            deviceListItems: [
              { deviceSn: runtime.device, deviceType: "INVERTER" },
            ],
          };
    await maintenance.discover(runtime.tenantId);
    const recovered = await maintenance.reload(runtime.tenantId);
    assert.equal(recovered.ready, true);
    assert.equal(recovered.journal.pending, true);
    recovered.controller.disable = async () => 9;
    recovered.client.api = async () =>
      providerPayload({ device: recovered.device });
    await recovered.collect();
    assert.equal(recovered.journal.pending, false);
    assert.equal(recovered.controlEnabled, false);
    assert.equal(recovered.verification, null);
    const row = (
      await pool.query(
        "SELECT status,verified_at,reconciled_at FROM inverter_write_intents WHERE id=$1",
        [id],
      )
    ).rows[0];
    assert.equal(row.status, "uncertain");
    assert.equal(row.verified_at, null);
    assert.ok(row.reconciled_at);
  } finally {
    await maintenance.close();
  }
});

test("changing inverter or profile cannot abandon unconfirmed charging permission", async (t) => {
  t.mock.method(TenantRuntime.prototype, "start", () => {});
  const { runtime } = await armedFixture();
  const maintenance = new AccountHub(pool, runtime.hub.env, key);
  maintenance.runtimes.set(runtime.tenantId, runtime);
  try {
    await runtime.journal.prepare(206, [0, 25], null);
    runtime.controller.disable = async () => {
      throw new Error("Inverter unreachable");
    };
    await assert.rejects(
      maintenance.updateAccount(runtime.tenantId, () =>
        maintenance.bind(runtime.tenantId, {
          deviceSn: runtime.device,
          profile: "monitor-only",
          timezone: "Europe/Sofia",
        }),
      ),
      /Confirm scheduled charging is off/,
    );
    const row = (
      await pool.query(
        "SELECT device_sn,profile FROM solarman_accounts WHERE tenant_id=$1",
        [runtime.tenantId],
      )
    ).rows[0];
    assert.equal(row.device_sn, runtime.device);
    assert.equal(row.profile, "bluesun-bse20kh3");
    const current = await maintenance.forTenant(runtime.tenantId);
    assert.equal(current.journal.pending, true);
    current.controller.disable = async () => 9;
    await current.clearScheduledPermission();
    await maintenance.updateAccount(runtime.tenantId, () =>
      maintenance.bind(runtime.tenantId, {
        deviceSn: runtime.device,
        profile: "monitor-only",
        timezone: "Europe/Sofia",
      }),
    );
    assert.equal(
      (await maintenance.forTenant(runtime.tenantId)).account.profile,
      "monitor-only",
    );
  } finally {
    await maintenance.close();
  }
});

test("a cached selected serial cannot become ready when discovery no longer returns it", async () => {
  const { runtime } = await controlFixture(true);
  let missing;
  try {
    missing = new TenantRuntime(runtime.hub, runtime.tenantId, {
      ...runtime.account,
      discovered_devices: [],
    });
    await missing.initialize();
    assert.equal(missing.ready, false);
    assert.equal(missing.writesEnabled, false);
    assert.match(missing.setupError, /not returned/);
  } finally {
    await missing?.close();
    await runtime.close();
  }
});

test("control journals cannot read or reconcile another workspace binding", async () => {
  const { runtime } = await armedFixture();
  try {
    await runtime.journal.prepare(206, [0, 25], null);
    const other = new ControlJournal(pool, {
      tenantId: ids.beta.tenant,
      accountId: ids.alpha.account,
      device: runtime.device,
    });
    await other.load();
    assert.deepEqual(other.status().writes, []);
    assert.equal(other.pending, false);
    await assert.rejects(other.confirmOff(9), { code: "23503" });
    assert.equal(runtime.journal.pending, true);
  } finally {
    await runtime.close();
  }
});

test("a queued hardware action records its job and intent before dispatch, then verifies readback", async () => {
  const { runtime, user, snapshot } = await controlFixture(true);
  let hardwareFlags = 9;
  try {
    await completeCommand(runtime, "verify", user);
    await completeCommand(runtime, "enable_controls", user);
    runtime.client.command = async (hex) => {
      const request = parseFrame(hex);
      assert.equal(request.readUInt16BE(2), 206);
      if (request[1] === 3)
        return frame(Buffer.from([1, 3, 4, 0, 0, 0, hardwareFlags]));
      assert.equal(request[1], 16);
      const recorded = (
        await pool.query(
          "SELECT status,execution_id FROM inverter_write_intents WHERE tenant_id=$1 AND device=$2 ORDER BY created_at DESC LIMIT 1",
          [runtime.tenantId, runtime.device],
        )
      ).rows[0];
      assert.equal(recorded.status, "prepared");
      assert.equal(recorded.execution_id, runtime.executionId);
      assert.ok(recorded.execution_id);
      assert.equal(runtime.status().control.recovery.inFlight, true);
      hardwareFlags = request.readUInt16BE(9);
      return frame(request.subarray(0, 6));
    };
    runtime.controller.tick = async () => {
      const flags = await runtime.controller.setAc(true);
      return {
        snapshot: { ...snapshot, flags },
        decision: { charge: true, reason: "below_reserve" },
      };
    };
    const job = await completeCommand(runtime, "resume", user);
    assert.equal(job.status, "succeeded");
    const row = (
      await pool.query(
        "SELECT status,acknowledged_at,verified_at FROM inverter_write_intents WHERE execution_id=$1",
        [job.id],
      )
    ).rows[0];
    assert.equal(row.status, "verified");
    assert.ok(row.acknowledged_at && row.verified_at);
    assert.equal(runtime.journal.status().state, "owned");
    assert.equal(runtime.status().control.recovery.inFlight, false);
    assert.equal(hardwareFlags, 25);
    runtime.controller.disable = async () => 9;
  } finally {
    await runtime.close();
  }
});

test("steady supervision uses one telemetry request between periodic native audits", async () => {
  const { runtime, user, snapshot, calls } = await controlFixture(true);
  try {
    snapshot.pvW = 500;
    snapshot.loadW = 800;
    snapshot.gridW = 2250;
    await completeCommand(runtime, "verify", user);
    await completeCommand(runtime, "enable_controls", user);
    await completeCommand(runtime, "resume", user);
    assert.equal(calls.filter((value) => value === "tick").length, 1);
    assert.equal(runtime.status().supervision.mode, "native");
    assert.equal(runtime.status().annualProjectedCalls, 148920);
    assert.equal(runtime.pollMs, 300000);
    const before = calls.filter((value) => value === "provider-read").length;
    const result = await runtime.collect();
    assert.equal(result.decision.reason, "native_charging");
    assert.equal(
      calls.filter((value) => value === "provider-read").length,
      before + 1,
    );
    assert.equal(calls.filter((value) => value === "tick").length, 1);
    assert.equal(runtime.telemetry.source, "provider");
    runtime.supervision.lastNativeAt -= 3600000;
    await runtime.collect();
    assert.equal(calls.filter((value) => value === "tick").length, 2);
    assert.equal(runtime.telemetry.source, "register");
  } finally {
    await runtime.close();
  }
});

test("explicit top-up requests force fresh native checks even when cached telemetry meets the target", async () => {
  const { runtime, user, calls } = await armedFixture();
  try {
    const before = calls.filter((value) => value === "tick").length;
    await completeCommand(runtime, "topup", user);
    assert.equal(calls.filter((value) => value === "tick").length, before + 1);
    assert.equal(runtime.manualTopup, true);
  } finally {
    await runtime.close();
  }
});

test("two distinct deviation uploads trigger one early audit without repeatedly polling unchanged data", async () => {
  const { runtime, user, snapshot, calls } = await controlFixture(true);
  try {
    snapshot.soc = 80;
    snapshot.pvW = 200;
    snapshot.loadW = 1800;
    snapshot.gridW = 100;
    snapshot.batteryW = 1500;
    let collectedAt = Math.floor((Date.now() - 300000) / 1000) * 1000;
    runtime.client.api = async (path) =>
      path === "/account/v1.0/balance"
        ? { total: 200000 }
        : providerPayload({
            device: runtime.device,
            collectedAt,
            values: {
              PVTP: String(snapshot.pvW),
              EP: String(snapshot.loadW),
              PG_Pt1: String(snapshot.gridW),
              B_P1: String(snapshot.batteryW),
              B_left_cap1: String(snapshot.soc),
            },
          });
    await completeCommand(runtime, "verify", user);
    await completeCommand(runtime, "enable_controls", user);
    await completeCommand(runtime, "resume", user);
    snapshot.batteryW = 0;
    snapshot.gridW = 1600;
    collectedAt += 60000;
    await runtime.collect();
    assert.equal(runtime.supervision.issue, null);
    collectedAt += 60000;
    await runtime.collect();
    assert.equal(runtime.supervision.issue.code, "battery_not_supporting_home");
    assert.equal(calls.filter((value) => value === "tick").length, 2);
    await runtime.collect();
    assert.equal(calls.filter((value) => value === "tick").length, 2);
  } finally {
    await runtime.close();
  }
});

test("a failed native policy audit pauses automation instead of repeatedly trying to enable it", async () => {
  const { runtime, calls } = await armedFixture();
  try {
    runtime.supervision.lastNativeAt -= 3600000;
    runtime.controller.tick = async () => {
      throw new Error("Inverter settings changed");
    };
    await runtime.evaluate();
    assert.equal(runtime.paused, true);
    assert.equal(runtime.inhibitStarts, true);
    assert.equal(runtime.status().control.canStart, false);
    const before = calls.filter((value) => value === "disable").length;
    await runtime.evaluate();
    assert.equal(calls.filter((value) => value === "disable").length, before);
    assert.equal(runtime.status().error, "Inverter settings changed");
    await runtime.collect(true);
    assert.equal(runtime.status().error, null);
    assert.equal(runtime.paused, true);
    assert.equal(
      (
        await pool.query(
          "SELECT paused FROM controller_state WHERE tenant_id=$1",
          [runtime.tenantId],
        )
      ).rows[0].paused,
      true,
    );
  } finally {
    await runtime.close();
  }
});

test("supervision caches are rebuilt with native checks after restart", async () => {
  const { runtime, snapshot } = await armedFixture();
  let restarted;
  try {
    const account = (
      await pool.query("SELECT * FROM solarman_accounts WHERE tenant_id=$1", [
        runtime.tenantId,
      ])
    ).rows[0];
    restarted = new TenantRuntime(runtime.hub, runtime.tenantId, account);
    await restarted.initialize();
    assert.equal(restarted.supervision.lastNativeAt, null);
    let checks = 0;
    restarted.client.api = async () =>
      providerPayload({ device: restarted.device });
    restarted.controller.tick = async () => {
      checks++;
      return { snapshot: { ...snapshot }, decision: decide(snapshot) };
    };
    restarted.controller.disable = async () => 9;
    await restarted.collect();
    assert.equal(checks, 1);
    assert.ok(restarted.supervision.lastNativeAt);
  } finally {
    await restarted?.close();
    await runtime.close();
  }
});

test("stale cached clock evidence blocks new starts without misreporting active supervision as read-only", async () => {
  const { runtime, user } = await armedFixture();
  try {
    runtime.clock.collectedAt = new Date(Date.now() - 601000).toISOString();
    assert.equal(runtime.status().mode, "active");
    assert.equal(runtime.status().control.canStart, false);
    assert.ok(
      runtime
        .status()
        .control.reasons.some((reason) => reason.code === "clock_refresh"),
    );
    await completeCommand(runtime, "refresh", user);
    assert.equal(runtime.status().control.canStart, true);
    assert.equal(runtime.status().mode, "active");
  } finally {
    await runtime.close();
  }
});

test("cleanup retries persisting the pause after a transient journal failure", async () => {
  const { runtime } = await armedFixture();
  try {
    runtime.supervision.lastNativeAt -= 3600000;
    runtime.controller.tick = async () => {
      throw new Error("Inverter settings changed");
    };
    const original = runtime.journal.requestCleanup.bind(runtime.journal);
    let attempts = 0;
    runtime.journal.requestCleanup = async (options = {}) => {
      if (options.pause && attempts++ === 0)
        throw new Error("Temporary database failure");
      await original(options);
    };
    await runtime.evaluate();
    assert.ok(attempts >= 2);
    assert.equal(
      (
        await pool.query(
          "SELECT paused FROM controller_state WHERE tenant_id=$1",
          [runtime.tenantId],
        )
      ).rows[0].paused,
      true,
    );
    assert.equal(runtime.status().error, "Inverter settings changed");
    assert.equal(runtime.journal.pending, false);
  } finally {
    await runtime.close();
  }
});

test("a delayed start update cannot overwrite a stop committed after the job began", async () => {
  const { runtime, user, calls } = await controlFixture(true);
  let restarted;
  let release;
  try {
    await completeCommand(runtime, "verify", user);
    await completeCommand(runtime, "enable_controls", user);
    const initial = (
      await pool.query(
        "SELECT control_epoch::text AS epoch FROM controller_state WHERE tenant_id=$1",
        [runtime.tenantId],
      )
    ).rows[0].epoch;
    let began;
    const started = new Promise((resolve) => {
      began = resolve;
    });
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const original = runtime.applyStartIntent.bind(runtime);
    runtime.applyStartIntent = async (action, epoch) => {
      if (action === "resume") {
        began();
        await gate;
      }
      return original(action, epoch);
    };
    const resume = await runtime.submit("resume", user, randomUUID());
    await started;
    const stop = await runtime.submit("stop", user, randomUUID());
    const committed = (
      await pool.query(
        "SELECT paused,control_epoch::text AS epoch FROM controller_state WHERE tenant_id=$1",
        [runtime.tenantId],
      )
    ).rows[0];
    assert.equal(committed.paused, true);
    assert.ok(BigInt(committed.epoch) > BigInt(initial));
    release();
    await runtime.work.idle();
    const jobs = (
      await pool.query(
        "SELECT id,status FROM command_executions WHERE tenant_id=$1 AND id=ANY($2::uuid[])",
        [runtime.tenantId, [resume.id, stop.id]],
      )
    ).rows;
    assert.equal(
      jobs.find((job) => job.id === resume.id).status,
      "interrupted",
    );
    assert.equal(jobs.find((job) => job.id === stop.id).status, "succeeded");
    assert.equal(calls.includes("tick"), false);
    const account = (
      await pool.query("SELECT * FROM solarman_accounts WHERE tenant_id=$1", [
        runtime.tenantId,
      ])
    ).rows[0];
    restarted = new TenantRuntime(runtime.hub, runtime.tenantId, account);
    await restarted.initialize();
    assert.equal(await restarted.applyStartIntent("resume", initial), false);
    assert.equal(
      (
        await pool.query(
          "SELECT paused FROM controller_state WHERE tenant_id=$1",
          [runtime.tenantId],
        )
      ).rows[0].paused,
      true,
    );
  } finally {
    release?.();
    await restarted?.close();
    await runtime.close();
  }
});

test("an old binding cannot borrow current activation to create cleanup ownership", async () => {
  const { runtime } = await armedFixture();
  const original = (
    await pool.query(
      "SELECT device_sn,discovered_devices FROM solarman_accounts WHERE tenant_id=$1",
      [runtime.tenantId],
    )
  ).rows[0];
  try {
    await runtime.journal.confirmOff(9);
    await pool.query(
      "UPDATE solarman_accounts SET device_sn='replacement-inverter',discovered_devices=$2 WHERE tenant_id=$1",
      [
        runtime.tenantId,
        JSON.stringify([{ deviceSn: "replacement-inverter" }]),
      ],
    );
    await runtime.journal.requestCleanup({ pause: true, cancelStarts: true });
    assert.equal(runtime.journal.owned, false);
    assert.equal(runtime.journal.pending, false);
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM device_control_state WHERE tenant_id=$1 AND state<>'clear'",
          [runtime.tenantId],
        )
      ).rows[0].count,
      0,
    );
  } finally {
    await pool.query(
      "UPDATE solarman_accounts SET device_sn=$2,discovered_devices=$3 WHERE tenant_id=$1",
      [
        runtime.tenantId,
        original.device_sn,
        JSON.stringify(original.discovered_devices),
      ],
    );
    await runtime.close();
  }
});

test("a persisted pause reconciles owned permission before returning to monitoring", async () => {
  const { runtime, calls } = await armedFixture();
  try {
    const id = await runtime.journal.prepare(
      2509,
      [0x1000, 0x1019, 0, 0, 0, 0, 0, 0],
      null,
    );
    await runtime.journal.acknowledge(id);
    await runtime.journal.verify(id);
    assert.equal(runtime.journal.state.state, "owned");
    await pool.query(
      "UPDATE controller_state SET paused=true,manual_topup=false WHERE tenant_id=$1",
      [runtime.tenantId],
    );
    await runtime.initialize();
    assert.equal(runtime.cleanupRequired, true);
    await runtime.collect();
    assert.equal(runtime.journal.owned, false);
    assert.equal(runtime.cleanupRequired, false);
    assert.equal(calls.filter((call) => call === "disable").length, 1);
  } finally {
    await runtime.close();
  }
});

test("command history paginates every write and preserves original uncertainty, device and tenant ownership", async () => {
  const { runtime, user } = await armedFixture();
  try {
    const job = await completeCommand(runtime, "topup", user);
    assert.equal(job.device, runtime.device);
    await pool.query(
      "UPDATE command_executions SET status='running',completed_at=null,detail=$2 WHERE id=$1",
      [
        job.id,
        {
          secret: "history-private-marker",
          events: [
            {
              event: "native_policy_check",
              reason: "topup_assessment",
              token: "history-private-marker",
            },
          ],
        },
      ],
    );
    const uncertain = await runtime.journal.prepare(206, [0, 25], job.id);
    await runtime.journal.acknowledge(uncertain);
    const running = await (
      await fetchApi(`/activity/${job.id}`, { auth: alpha })
    ).json();
    assert.equal(running.writes[0].inFlight, true);
    assert.equal(running.writes[0].verifiedAt, null);
    await runtime.journal.uncertain(uncertain);
    await pool.query(
      "UPDATE command_executions SET status='failed',completed_at=now(),message='Device acknowledgment timed out; command outcome is unknown' WHERE id=$1",
      [job.id],
    );
    await runtime.journal.confirmOff(9);
    for (let index = 0; index < 25; index++)
      await pool.query(
        `INSERT INTO inverter_write_intents (id,tenant_id,account_id,device,execution_id,operation,address,register_values,status,created_at,acknowledged_at,verified_at)
        VALUES ($1,$2,$3,$4,$5,'window',2509,'[4096,4121,0,0,0,0,0,0]','verified',now()-interval '1 hour'+($6*interval '1 second'),now(),now())`,
        [
          randomUUID(),
          runtime.tenantId,
          runtime.account.id,
          runtime.device,
          job.id,
          index,
        ],
      );
    const originalDevice = runtime.device;
    await pool.query(
      "UPDATE solarman_accounts SET device_sn='new-binding-for-history-test' WHERE tenant_id=$1",
      [runtime.tenantId],
    );
    const first = await (
      await fetchApi(`/activity/${job.id}`, { auth: alpha })
    ).json();
    assert.equal(first.device, originalDevice);
    assert.equal(first.writes.length, 25);
    assert.equal(first.hasMoreWrites, true);
    assert.equal(
      first.writes.every(
        (write) =>
          write.device === originalDevice && write.status === "verified",
      ),
      true,
    );
    assert.deepEqual(
      first.writes[0].registerValues,
      [4096, 4121, 0, 0, 0, 0, 0, 0],
    );
    assert.equal(first.writes[0].address, 2509);
    assert.equal(
      JSON.stringify(first).includes("history-private-marker"),
      false,
    );
    const second = await (
      await fetchApi(`/activity/${job.id}?offset=25`, { auth: alpha })
    ).json();
    assert.equal(second.writes.length, 1);
    assert.equal(second.hasMoreWrites, false);
    assert.equal(second.writes[0].id, uncertain);
    assert.equal(second.writes[0].status, "uncertain");
    assert.equal(second.writes[0].verifiedAt, null);
    assert.ok(second.writes[0].acknowledgedAt);
    assert.ok(second.writes[0].reconciledAt);
    assert.equal(second.writes[0].inFlight, false);
    const allFirst = await (
      await fetchApi("/write-history", { auth: alpha })
    ).json();
    const allSecond = await (
      await fetchApi("/write-history?offset=25", { auth: alpha })
    ).json();
    assert.equal(allFirst.writes[0].id, uncertain);
    assert.equal(allFirst.hasMoreWrites, true);
    assert.equal(allSecond.writes.length, 1);
    assert.equal(allSecond.hasMoreWrites, false);
    assert.equal(
      new Set(
        [...allFirst.writes, ...allSecond.writes].map((write) => write.id),
      ).size,
      26,
    );
    assert.equal(
      (await fetchApi(`/activity/${job.id}`, { auth: beta })).status,
      404,
    );
    assert.equal(
      (await fetchApi(`/activity/${randomUUID()}`, { auth: alpha })).status,
      404,
    );
    for (const offset of ["-1", "1.5", "1000000"])
      assert.equal(
        (
          await fetchApi(`/activity/${job.id}?offset=${offset}`, {
            auth: alpha,
          })
        ).status,
        400,
      );
    const list = await (await fetchApi("/activity", { auth: alpha })).json();
    assert.equal(
      JSON.stringify(list).includes("history-private-marker"),
      false,
    );
  } finally {
    await pool.query(
      "UPDATE solarman_accounts SET device_sn=$2 WHERE tenant_id=$1",
      [runtime.tenantId, runtime.device],
    );
    await runtime.close();
  }
});

test("full write history includes unlinked recovery writes and previous bindings, with tenant isolation", async () => {
  const { runtime } = await armedFixture();
  try {
    const recovery = await runtime.journal.prepare(206, [0, 9], null);
    await runtime.journal.acknowledge(recovery);
    await runtime.journal.verify(recovery);
    await pool.query(
      "UPDATE solarman_accounts SET device_sn='replacement-for-recovery-history' WHERE tenant_id=$1",
      [runtime.tenantId],
    );
    const response = await fetchApi("/write-history", { auth: alpha });
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.writes.length, 1);
    assert.equal(data.writes[0].id, recovery);
    assert.equal(data.writes[0].executionId, null);
    assert.equal(data.writes[0].status, "verified");
    assert.deepEqual(data.writes[0].registerValues, [0, 9]);
    assert.deepEqual(
      (await (await fetchApi("/write-history", { auth: beta })).json()).writes,
      [],
    );
    assert.equal(
      (await fetchApi("/write-history?offset=-1", { auth: alpha })).status,
      400,
    );
  } finally {
    await pool.query(
      "UPDATE solarman_accounts SET device_sn=$2 WHERE tenant_id=$1",
      [runtime.tenantId, runtime.device],
    );
    await runtime.close();
  }
});

test("history migration backfills only unambiguous devices within the original tenant", async () => {
  const connection = await pool.connect();
  try {
    await connection.query("BEGIN");
    await connection.query(
      "CREATE TEMP TABLE command_executions (tenant_id text,id text,detail jsonb) ON COMMIT DROP",
    );
    await connection.query(
      "CREATE TEMP TABLE inverter_write_intents (tenant_id text,execution_id text,device text,created_at timestamptz,id text) ON COMMIT DROP",
    );
    await connection.query(
      "INSERT INTO command_executions (tenant_id,id) VALUES ('a','shared-id'),('b','shared-id'),('a','ambiguous'),('a','unwritten'),('a','verified-only'),('a','conflicting-report')",
    );
    await connection.query(
      "INSERT INTO inverter_write_intents (tenant_id,execution_id,device) VALUES ('a','shared-id','old-a'),('a','shared-id','old-a'),('b','shared-id','old-b'),('a','ambiguous','old-a'),('a','ambiguous','other-device')",
    );
    await connection.query(
      "UPDATE command_executions SET detail=$1 WHERE id IN ('verified-only','conflicting-report')",
      [
        {
          events: [
            {
              event: "device_verification",
              report: { device: "verified-device" },
            },
          ],
        },
      ],
    );
    await connection.query(
      "INSERT INTO inverter_write_intents (tenant_id,execution_id,device) VALUES ('a','conflicting-report','different-device')",
    );
    await connection.query(
      await readFile(
        new URL("../../migrations/009_command_history.sql", import.meta.url),
        "utf8",
      ),
    );
    const result = await connection.query(
      "SELECT tenant_id,id,device FROM command_executions ORDER BY tenant_id,id",
    );
    assert.deepEqual(result.rows, [
      { tenant_id: "a", id: "ambiguous", device: null },
      { tenant_id: "a", id: "conflicting-report", device: null },
      { tenant_id: "a", id: "shared-id", device: "old-a" },
      { tenant_id: "a", id: "unwritten", device: null },
      { tenant_id: "a", id: "verified-only", device: "verified-device" },
      { tenant_id: "b", id: "shared-id", device: "old-b" },
    ]);
  } finally {
    await connection.query("ROLLBACK");
    connection.release();
  }
});

test("device health persists real upload time and consecutive failures across restarts", async () => {
  const { runtime } = await controlFixture();
  let restarted;
  try {
    const at = new Date(Date.now() - 120000);
    runtime.client.api = async () =>
      providerPayload({ device: runtime.device, collectedAt: at.getTime() });
    await runtime.collect();
    runtime.client.api = async () =>
      providerPayload({
        device: runtime.device,
        collectedAt: at.getTime() - 60000,
      });
    await runtime.collect();
    let state = await hub.operations.deviceStatus(runtime.tenantId);
    assert.equal(
      new Date(state.uploadedAt).getTime(),
      Math.floor(at.getTime() / 1000) * 1000,
    );
    assert.ok(
      new Date(state.succeededAt).getTime() >
        new Date(state.uploadedAt).getTime(),
    );
    runtime.client.api = async () => {
      throw new Error("private-health-error-marker");
    };
    for (let index = 0; index < 3; index++)
      await assert.rejects(runtime.collect(), /private-health-error-marker/);
    await hub.operations.refresh();
    let data = await (await fetchApi("/operations", { auth: alpha })).json();
    assert.ok(data.items.some((item) => item.kind === "request_failures"));
    assert.equal(data.deviceHealth.failures, 3);
    assert.equal(
      JSON.stringify(data).includes("private-health-error-marker"),
      false,
    );
    restarted = new TenantRuntime(
      runtime.hub,
      runtime.tenantId,
      runtime.account,
    );
    await restarted.initialize();
    const persisted = new Operations(pool, hub);
    assert.equal(
      (await persisted.list(runtime.tenantId)).items[0].id,
      data.items[0].id,
    );
    restarted.client.api = async () =>
      providerPayload({ device: runtime.device });
    await restarted.collect();
    await hub.operations.refresh();
    state = await hub.operations.deviceStatus(runtime.tenantId);
    assert.equal(state.failures, 0);
    data = await (
      await fetchApi("/operations?filter=resolved", { auth: alpha })
    ).json();
    assert.ok(
      data.items.some(
        (item) =>
          item.kind === "request_failures" &&
          item.resolutionReason === "cleared",
      ),
    );
  } finally {
    await restarted?.close();
    await runtime.close();
  }
});

test("alerts deduplicate, acknowledgments are scoped and escalation becomes unseen without resolving the condition", async () => {
  const { runtime } = await controlFixture();
  const scope = "quota-test-scope";
  const scopes = new Set([scope]);
  const base = {
    account_id: runtime.account.id,
    device: runtime.device,
    binding: scope,
    kind: "api_quota",
    severity: "warning",
    detailCode: "low",
    at: new Date(),
  };
  try {
    await Promise.all([
      hub.operations.reconcile(runtime.tenantId, [base], scopes),
      hub.operations.reconcile(runtime.tenantId, [base], scopes),
    ]);
    let list = await hub.operations.list(runtime.tenantId);
    assert.equal(list.total, 1);
    const id = list.items[0].id;
    assert.equal(
      (
        await fetchApi(`/incidents/${id}/acknowledge`, {
          auth: beta,
          method: "POST",
          body: { revision: 1 },
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await fetchApi(`/incidents/${id}/acknowledge`, {
          auth: alpha,
          method: "POST",
          body: { revision: 1 },
          csrf: false,
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetchApi(`/incidents/${id}/acknowledge`, {
          auth: alpha,
          method: "POST",
          body: { revision: 1 },
          originHeader: false,
        })
      ).status,
      403,
    );
    const seen = await (
      await fetchApi(`/incidents/${id}/acknowledge`, {
        auth: alpha,
        method: "POST",
        body: { revision: 1 },
      })
    ).json();
    const duplicate = await (
      await fetchApi(`/incidents/${id}/acknowledge`, {
        auth: alpha,
        method: "POST",
        body: { revision: 1 },
      })
    ).json();
    assert.equal(seen.acknowledgedAt, duplicate.acknowledgedAt);
    assert.equal(duplicate.resolvedAt, null);
    assert.equal((await hub.operations.summary(runtime.tenantId)).unseen, 0);
    await hub.operations.reconcile(
      runtime.tenantId,
      [{ ...base, severity: "critical", detailCode: "recovery-only" }],
      scopes,
    );
    list = await hub.operations.list(runtime.tenantId);
    assert.equal(list.items[0].revision, 2);
    assert.equal(list.items[0].acknowledgedAt, null);
    assert.equal(
      (
        await fetchApi(`/incidents/${id}/acknowledge`, {
          auth: alpha,
          method: "POST",
          body: { revision: 1 },
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await fetchApi(`/incidents/${id}/acknowledge`, {
          auth: alpha,
          method: "POST",
          body: { revision: 0 },
        })
      ).status,
      400,
    );
    await hub.operations.acknowledge(runtime.tenantId, id, ids.alpha.user, 2);
    await hub.operations.reconcile(
      runtime.tenantId,
      [{ ...base, severity: "critical", detailCode: "exhausted" }],
      scopes,
    );
    await hub.operations.reconcile(
      runtime.tenantId,
      [{ ...base, severity: "critical", detailCode: "exhausted" }],
      scopes,
    );
    list = await hub.operations.list(runtime.tenantId);
    assert.equal(list.items[0].revision, 3);
    assert.equal(list.unseen, 1);
    await hub.operations.reconcile(runtime.tenantId, [], scopes);
    assert.equal((await hub.operations.list(runtime.tenantId)).total, 0);
    assert.equal(
      (await hub.operations.list(runtime.tenantId, "resolved")).items[0]
        .resolutionReason,
      "cleared",
    );
    await hub.operations.reconcile(runtime.tenantId, [base], scopes);
    list = await hub.operations.list(runtime.tenantId, "all");
    assert.equal(list.total, 2);
    const beyond = await hub.operations.list(runtime.tenantId, "all", 9999);
    assert.equal(beyond.total, 2);
    assert.equal(beyond.items.length, 0);
    assert.notEqual(list.items[0].id, id);
    const other = await (await fetchApi("/operations", { auth: beta })).json();
    assert.equal(
      other.items.some((item) => item.id === id),
      false,
    );
    assert.equal(
      (await fetchApi("/operations?filter=invalid", { auth: alpha })).status,
      400,
    );
    assert.equal(
      (await fetchApi("/operations?offset=-1", { auth: alpha })).status,
      400,
    );
  } finally {
    await runtime.close();
  }
});

test("binding changes resolve old monitoring alerts without abandoning outstanding cleanup", async () => {
  const { runtime } = await controlFixture();
  try {
    await pool.query(
      "UPDATE device_health SET uploaded_at=now()-interval '1 hour' WHERE tenant_id=$1",
      [runtime.tenantId],
    );
    await hub.operations.refresh();
    assert.ok(
      (await hub.operations.list(runtime.tenantId)).items.some(
        (item) => item.kind === "telemetry_stale",
      ),
    );
    await pool.query(
      "UPDATE solarman_accounts SET device_sn='replacement-health-device' WHERE tenant_id=$1",
      [runtime.tenantId],
    );
    await pool.query(
      "INSERT INTO device_control_state (tenant_id,account_id,device,state,updated_at) VALUES ($1,$2,$3,'cleanup-required',now()-interval '3 minutes')",
      [runtime.tenantId, runtime.account.id, runtime.device],
    );
    await hub.operations.refresh();
    const old = await hub.operations.list(runtime.tenantId, "resolved");
    assert.ok(
      old.items.some(
        (item) =>
          item.kind === "telemetry_stale" &&
          item.resolutionReason === "binding_changed",
      ),
    );
    assert.ok(
      (await hub.operations.list(runtime.tenantId)).items.some(
        (item) =>
          item.kind === "cleanup_pending" && item.device === runtime.device,
      ),
    );
    await runtime.journal.confirmOff(9);
    await hub.operations.refresh();
    assert.ok(
      (await hub.operations.list(runtime.tenantId, "resolved")).items.some(
        (item) =>
          item.kind === "cleanup_pending" &&
          item.resolutionReason === "cleared",
      ),
    );
  } finally {
    await pool.query(
      "UPDATE solarman_accounts SET device_sn=$2 WHERE tenant_id=$1",
      [runtime.tenantId, runtime.device],
    );
    await runtime.close();
  }
});

test("a persisted control fault forces pause after restart and only native success clears it", async () => {
  const { runtime } = await armedFixture();
  let restarted;
  try {
    await runtime.health.controlFault(true);
    await pool.query(
      "UPDATE controller_state SET paused=false,manual_topup=true,topup_expires_at=now()+interval '1 hour' WHERE tenant_id=$1",
      [runtime.tenantId],
    );
    restarted = new TenantRuntime(
      runtime.hub,
      runtime.tenantId,
      runtime.account,
    );
    await restarted.initialize();
    restarted.client.api = async () =>
      providerPayload({ device: runtime.device });
    restarted.controller.disable = async () => 9;
    restarted.inspector = runtime.inspector;
    assert.equal(restarted.paused, true);
    assert.equal(restarted.manualTopup, false);
    assert.equal(restarted.readiness().canStart, false);
    const persisted = (
      await pool.query(
        "SELECT paused,manual_topup FROM controller_state WHERE tenant_id=$1",
        [runtime.tenantId],
      )
    ).rows[0];
    assert.deepEqual(persisted, { paused: true, manual_topup: false });
    await restarted.collect();
    assert.equal(
      (await hub.operations.deviceStatus(runtime.tenantId)).controlFault,
      true,
    );
    await restarted.collect(true);
    assert.equal(
      (await hub.operations.deviceStatus(runtime.tenantId)).controlFault,
      false,
    );
    assert.equal(restarted.paused, true);
    assert.equal(restarted.readiness().canStart, true);
  } finally {
    await restarted?.close();
    await runtime.close();
  }
});

test("operational quota checks share one cached status lookup without sending device requests", async () => {
  const { runtime, calls } = await controlFixture();
  let probes = 0;
  const monitor = new Operations(pool, {
    runtimes: new Map([
      [runtime.tenantId, { appKey: "shared-operational-app", pollMs: 300000 }],
      [ids.beta.tenant, { appKey: "shared-operational-app", pollMs: 300000 }],
    ]),
    budget: {
      status: async () => {
        probes++;
        return { routineRemaining: 0, limit: 200000, state: "recovery-only" };
      },
    },
  });
  try {
    await monitor.refresh();
    assert.equal(probes, 1);
    assert.deepEqual(calls, []);
    const data = await monitor.list(runtime.tenantId);
    assert.equal(
      data.items.find((item) => item.kind === "api_quota").severity,
      "critical",
    );
    assert.equal(
      data.items.find((item) => item.kind === "api_quota").detailCode,
      "recovery-only",
    );
  } finally {
    await pool.query(
      "DELETE FROM operational_incidents WHERE tenant_id=$1 AND binding LIKE 'api:shared-operational-app:%'",
      [ids.beta.tenant],
    );
    await runtime.close();
  }
});

test("public health distinguishes a delayed operational monitor without exposing tenant details", async () => {
  const before = {
    checkedAt: hub.operations.checkedAt,
    startedAt: hub.operations.startedAt,
  };
  try {
    hub.operations.checkedAt = Date.now() - 180001;
    const response = await fetch(`${origin}/healthz`);
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.status, "degraded");
    assert.equal(body.monitoring, "delayed");
    assert.equal(JSON.stringify(body).includes(ids.alpha.device), false);
    hub.operations.checkedAt = Date.now();
    assert.equal((await fetch(`${origin}/healthz`)).status, 200);
  } finally {
    Object.assign(hub.operations, before);
  }
});
