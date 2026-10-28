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
import { TenantRuntime } from "../../src/tenant-runtime.mjs";
import { decide } from "../../src/controller.mjs";
import { providerPayload } from "../fixtures/provider.mjs";
import { ApiBudget, ApiBudgetError, apiAppKey } from "../../src/api-budget.mjs";
import { ControlJournal } from "../../src/control-journal.mjs";
import { parseFrame, frame } from "../../src/modbus.mjs";

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

async function controlFixture(writes = false) {
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
    assert.equal(
      (await completeCommand(runtime, "verify", user)).status,
      "succeeded",
    );
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
  const { runtime, user } = await controlFixture();
  const originalQuery = runtime.q.bind(runtime);
  try {
    runtime.q = async (sql, values = []) => {
      const result = await originalQuery(sql, values);
      if (sql.includes("INSERT INTO command_executions"))
        runtime.stopping = true;
      return result;
    };
    const job = await runtime.submit("refresh", user, randomUUID());
    let status = "queued";
    for (let attempt = 0; attempt < 20 && status === "queued"; attempt++) {
      status = (
        await originalQuery(
          "SELECT status FROM command_executions WHERE tenant_id=$1 AND id=$2",
          [job.id],
        )
      ).rows[0].status;
      if (status === "queued")
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(status, "failed");
    assert.equal(runtime.scheduled.has(job.id), false);
  } finally {
    await runtime.close();
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
