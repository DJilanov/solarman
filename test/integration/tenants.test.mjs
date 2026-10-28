import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createPool, migrate } from "../../src/database.mjs";
import { dashboardConfig } from "../../src/dashboard-config.mjs";
import { hashPassword, tokenHash } from "../../src/auth.mjs";
import {
  encryptCredentials,
  verifyStoredCredentials,
  decryptCredentials,
} from "../../src/credentials.mjs";
import { AccountHub } from "../../src/account-hub.mjs";
import { createApp } from "../../src/http-app.mjs";
import { localDay } from "../../src/analytics.mjs";
import { TenantRuntime } from "../../src/tenant-runtime.mjs";
import { decide } from "../../src/controller.mjs";
import { providerPayload } from "../fixtures/provider.mjs";
import { ApiBudget, ApiBudgetError, apiAppKey } from "../../src/api-budget.mjs";
import { ApiCapacityError } from "../../src/api-capacity.mjs";
import { ControlJournal } from "../../src/control-journal.mjs";
import { parseFrame, frame } from "../../src/modbus.mjs";
import { Operations } from "../../src/operations.mjs";
import { AccountRecovery } from "../../src/account-recovery.mjs";
import { WorkspaceData } from "../../src/workspace-data.mjs";
import { DataMaintenance } from "../../src/data-maintenance.mjs";
import { TenantLifecycle } from "../../src/tenant-lifecycle.mjs";
import { WorkspaceOffboarding } from "../../src/workspace-offboarding.mjs";
import { Invitations, lockInvitationEmail } from "../../src/invitations.mjs";
import {
  AccountSecurity,
  SecurityError,
  createBrowserSession,
} from "../../src/account-security.mjs";

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
    agent,
    clientIp,
  } = {},
) {
  const headers = {
    ...(auth ? { cookie: auth.cookie } : {}),
    ...(originHeader ? { origin: "http://localhost" } : {}),
    ...(body ? { "content-type": "application/json" } : {}),
    ...(auth && csrf ? { "x-csrf-token": auth.csrfToken } : {}),
    ...(idempotency ? { "idempotency-key": idempotency } : {}),
    ...(agent ? { "user-agent": agent } : {}),
    ...(clientIp ? { "x-real-ip": clientIp } : {}),
  };
  return fetch(`${origin}/api${path}`, {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

async function login(email, loginPassword = password, agent) {
  const response = await fetchApi("/auth/login", {
    method: "POST",
    body: { email, password: loginPassword },
    agent,
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
  assert.ok(a.backup);
  assert.equal(Object.hasOwn(b, "backup"), false);
  const healthA = await (await fetchApi("/operations", { auth: alpha })).json();
  const healthB = await (await fetchApi("/operations", { auth: beta })).json();
  assert.ok(healthA.backup);
  assert.equal(Object.hasOwn(healthB, "backup"), false);
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
  const token = new URLSearchParams(
    new URL((await invite.json()).url).hash.slice(1),
  ).get("token");
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

async function controlFixture(writes = false, owner = ids.alpha) {
  await pool.query("DELETE FROM operational_incidents WHERE tenant_id=$1", [
    owner.tenant,
  ]);
  await pool.query("DELETE FROM device_health WHERE tenant_id=$1", [
    owner.tenant,
  ]);
  await pool.query("DELETE FROM inverter_write_intents WHERE tenant_id=$1", [
    owner.tenant,
  ]);
  await pool.query("DELETE FROM device_control_state WHERE tenant_id=$1", [
    owner.tenant,
  ]);
  await pool.query(
    "UPDATE solarman_accounts SET profile='bluesun-bse20kh3' WHERE tenant_id=$1",
    [owner.tenant],
  );
  await pool.query(
    "UPDATE controller_state SET paused=true,manual_topup=false,control_enabled=false,verification=null,topup_expires_at=null WHERE tenant_id=$1",
    [owner.tenant],
  );
  const row = (
    await pool.query("SELECT * FROM solarman_accounts WHERE tenant_id=$1", [
      owner.tenant,
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
      monitorPollMs: (runtime) =>
        runtime.hub.budget.capacityFor(runtime.appKey, runtime.tenantId)
          ?.monitorMs ?? runtime.monitorPollMs,
      runLimited: async (operation) => operation(),
    },
    owner.tenant,
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
  const firmware = { DSP_V_M: "1.57", HMIVN: "1.45" };
  runtime.client.api = async (path, body) => {
    if (path === "/account/v1.0/balance")
      return { success: true, total: 200000 };
    assert.equal(path, "/device/v1.0/currentData");
    assert.equal(body.deviceSn, runtime.device);
    calls.push("provider-read");
    return providerPayload({
      device: runtime.device,
      values: {
        ...firmware,
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
    firmware,
    user: {
      tenant_id: owner.tenant,
      id: owner.user,
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
    assert.equal(history.evidence.verification.checks.length, 9);
    assert.deepEqual(history.evidence.verification.firmware, {
      protocol: "2.02",
      dsp: "1.57",
      hmi: "1.45",
    });
    assert.equal(history.evidence.verification.passed, true);
    assert.equal(history.device, runtime.device);
    assert.deepEqual(history.writes, []);
    assert.equal(runtime.status().control.verification.passed, true);
    assert.equal(runtime.status().control.verification.checks.length, 9);
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
    assert.equal(runtime.status().control.verificationStatus.state, "expired");
    assert.equal(
      (await completeCommand(runtime, "enable_controls", user)).status,
      "failed",
    );
    assert.equal(runtime.controlEnabled, false);
  } finally {
    await runtime.close();
  }
});

test("a newer passing clock observation retains the failed saved report until explicit verification", async () => {
  const { runtime, user, calls } = await controlFixture(true);
  const normalApi = runtime.client.api;
  try {
    runtime.client.api = async () =>
      providerPayload({
        device: runtime.device,
        collectedAt: Date.now() - 300_000,
        values: { SYSTIM1: "2000-01-01 00:00:00" },
      });
    const report = await runtime.verifyDevice();
    assert.equal(report.passed, false);
    const failed = runtime.status().control;
    assert.equal(failed.verificationStatus.state, "failed");
    assert.equal(failed.clock.passed, false);
    assert.equal(failed.clock.maximumSkewSeconds, 120);
    runtime.client.api = normalApi;
    await runtime.collectProvider();
    const updated = runtime.status().control;
    assert.equal(updated.clock.passed, true);
    assert.equal(updated.clock.fresh, true);
    assert.equal(updated.verificationStatus.state, "failed");
    assert.equal(updated.verificationStatus.checkedAt, report.checkedAt);
    assert.equal(updated.canEnable, false);
    assert.equal(updated.canStart, false);
    assert.equal(runtime.controlEnabled, false);
    assert.equal(calls.includes("tick"), false);
    const previous = hub.runtimes.get(runtime.tenantId);
    hub.runtimes.set(runtime.tenantId, runtime);
    try {
      const response = await fetchApi("/overview", { auth: alpha });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.controller.control.verificationStatus.state, "failed");
      assert.equal(
        body.controller.control.verificationStatus.checkedAt,
        report.checkedAt,
      );
      assert.equal(body.controller.control.clock.passed, true);
      assert.equal(body.controller.control.canEnable, false);
    } finally {
      if (previous) hub.runtimes.set(runtime.tenantId, previous);
      else hub.runtimes.delete(runtime.tenantId);
    }
    await completeCommand(runtime, "verify", user);
    assert.equal(runtime.status().control.verificationStatus.state, "verified");
    assert.equal(runtime.status().control.canEnable, true);
    assert.equal(runtime.status().control.workspaceEnabled, false);
    assert.equal(runtime.status().control.canStart, false);
    assert.equal(runtime.paused, true);
  } finally {
    await runtime.close();
  }
});

test("clock evidence retains its device timestamp and stale cached uploads block activation", async () => {
  const { runtime, user } = await controlFixture(true);
  try {
    await completeCommand(runtime, "verify", user);
    const collectedAt = Date.now() - 570_000;
    const payload = providerPayload({ device: runtime.device, collectedAt });
    runtime.client.api = async () => payload;
    await runtime.collectProvider();
    const before = runtime.status().control.clock;
    assert.equal(before.fresh, true);
    assert.equal(
      before.collectedAt,
      new Date(payload.collectionTime * 1000).toISOString(),
    );
    await runtime.collectProvider();
    assert.equal(
      runtime.status().control.clock.collectedAt,
      before.collectedAt,
    );
    runtime.clock.collectedAt = new Date(Date.now() - 601_000).toISOString();
    const stale = runtime.status().control;
    assert.equal(stale.clock.fresh, false);
    assert.equal(stale.verificationStatus.state, "verified");
    assert.equal(stale.canEnable, false);
    assert.ok(stale.reasons.some((reason) => reason.code === "clock_refresh"));
    runtime.clock.collectedAt = "invalid";
    assert.equal(runtime.status().control.clock.fresh, false);
    runtime.clock.collectedAt = new Date(Date.now() + 31_000).toISOString();
    assert.equal(runtime.status().control.clock.fresh, false);
  } finally {
    await runtime.close();
  }
});

test("unvalidated firmware permits monitoring but cannot pass control verification", async () => {
  const { runtime, firmware, user, calls } = await controlFixture(true);
  try {
    firmware.DSP_V_M = "1.58";
    assert.equal(
      (await completeCommand(runtime, "verify", user)).status,
      "succeeded",
    );
    assert.equal(runtime.verification.passed, false);
    assert.equal(
      runtime.verification.checks.at(-1).label,
      "Firmware compatibility",
    );
    assert.equal(runtime.verification.checks.at(-1).passed, false);
    assert.equal(
      (await completeCommand(runtime, "enable_controls", user)).status,
      "failed",
    );
    await runtime.collectProvider();
    assert.equal(runtime.telemetry.source, "provider");
    assert.equal(runtime.status().control.canStart, false);
    assert.equal(calls.includes("tick"), false);
    assert.equal(runtime.verification.passed, false);
  } finally {
    await runtime.close();
  }
});

test("a firmware change revokes activation atomically, preserves cleanup and cancels a queued start", async () => {
  const { runtime, firmware, user, calls } = await armedFixture();
  try {
    const intent = await runtime.journal.prepare(206, [0, 25], null);
    await runtime.journal.verify(intent);
    runtime.controller.disable = async () => {
      throw new Error("fixture unavailable cleanup");
    };
    firmware.HMIVN = "1.46";
    const job = await completeCommand(runtime, "topup", user);
    assert.equal(job.status, "failed");
    const saved = (
      await pool.query(
        "SELECT paused,manual_topup,control_enabled,verification,control_epoch FROM controller_state WHERE tenant_id=$1",
        [runtime.tenantId],
      )
    ).rows[0];
    assert.equal(saved.paused, true);
    assert.equal(saved.manual_topup, false);
    assert.equal(saved.control_enabled, false);
    assert.equal(saved.verification, null);
    assert.equal(runtime.journal.pending, true);
    const before = calls.filter((c) => c === "tick").length;
    const epoch = saved.control_epoch;
    runtime.controller.disable = async () => 9;
    await runtime.collect();
    assert.equal(runtime.journal.pending, false);
    assert.equal(runtime.controlEnabled, false);
    assert.equal(calls.filter((c) => c === "tick").length, before);
    assert.equal(
      (
        await pool.query(
          "SELECT control_epoch FROM controller_state WHERE tenant_id=$1",
          [runtime.tenantId],
        )
      ).rows[0].control_epoch,
      epoch,
    );
    assert.equal(runtime.status().control.canStart, false);
  } finally {
    runtime.controller.disable = async () => 9;
    await runtime.close();
  }
});

test("a successful firmware mismatch cleanup interrupts the requesting start and remains revoked after restart", async () => {
  const { runtime, firmware, user, calls } = await armedFixture();
  let restarted;
  try {
    const before = calls.filter((c) => c === "tick").length;
    firmware.DSP_V_M = "1.58";
    const job = await completeCommand(runtime, "topup", user);
    assert.equal(job.status, "interrupted");
    assert.equal(calls.filter((c) => c === "tick").length, before);
    assert.equal(runtime.journal.pending, false);
    const account = (
      await pool.query("SELECT * FROM solarman_accounts WHERE tenant_id=$1", [
        runtime.tenantId,
      ])
    ).rows[0];
    restarted = new TenantRuntime(runtime.hub, runtime.tenantId, account);
    await restarted.initialize();
    assert.equal(restarted.controlEnabled, false);
    assert.equal(restarted.paused, true);
    assert.equal(restarted.verification, null);
    assert.equal(restarted.readiness().canStart, false);
  } finally {
    await restarted?.close();
    await runtime.close();
  }
});

test("protocol or model changes revoke control before an unsupported telemetry mapping can throw", async () => {
  for (const change of [{ PTCv1: "2.03" }, { MMN: "OTHER-MODEL" }]) {
    const { runtime, firmware, calls } = await armedFixture();
    try {
      const before = calls.filter((c) => c === "tick").length;
      Object.assign(firmware, change);
      await assert.rejects(runtime.collect(), /mapping/);
      const saved = (
        await pool.query(
          "SELECT control_enabled,paused,verification FROM controller_state WHERE tenant_id=$1",
          [runtime.tenantId],
        )
      ).rows[0];
      assert.equal(saved.control_enabled, false);
      assert.equal(saved.paused, true);
      assert.equal(saved.verification, null);
      assert.equal(calls.filter((c) => c === "tick").length, before);
    } finally {
      await runtime.close();
    }
  }
});

test("legacy verification without firmware cannot retain activation after a fresh upload", async () => {
  const { runtime } = await armedFixture();
  let restarted;
  try {
    const legacy = { ...runtime.verification };
    delete legacy.firmware;
    await pool.query(
      "UPDATE controller_state SET verification=$2 WHERE tenant_id=$1",
      [runtime.tenantId, legacy],
    );
    const account = (
      await pool.query("SELECT * FROM solarman_accounts WHERE tenant_id=$1", [
        runtime.tenantId,
      ])
    ).rows[0];
    restarted = new TenantRuntime(runtime.hub, runtime.tenantId, account);
    await restarted.initialize();
    restarted.client.api = async () =>
      providerPayload({ device: restarted.device });
    restarted.controller.disable = async () => 9;
    assert.equal(restarted.readiness().canStart, false);
    await restarted.collect();
    assert.equal(restarted.controlEnabled, false);
    assert.equal(restarted.paused, true);
    assert.equal(restarted.verification, null);
    assert.equal(restarted.journal.pending, false);
  } finally {
    await restarted?.close();
    await runtime.close();
  }
});

test("a failed settings report cannot retain old activation when firmware subsequently changes", async () => {
  const { runtime, firmware, user } = await armedFixture();
  try {
    await completeCommand(runtime, "pause", user);
    runtime.inspector.settings = async () => ({
      maximumSoc: 90,
      reserveSoc: 50,
    });
    await completeCommand(runtime, "verify", user);
    assert.equal(runtime.verification.passed, false);
    assert.equal(runtime.controlEnabled, true);
    firmware.HMIVN = "1.46";
    await runtime.collectProvider();
    assert.equal(runtime.controlEnabled, false);
    assert.equal(runtime.verification, null);
    assert.equal(runtime.paused, true);
    assert.equal(runtime.journal.pending, false);
  } finally {
    await runtime.close();
  }
});

test("an old device binding cannot revoke the current device's verification or activation", async () => {
  const { runtime } = await armedFixture();
  try {
    const old = new ControlJournal(pool, {
      ...runtime.journal.context,
      device: "retired-fixture-device",
    });
    await assert.rejects(
      old.requestCleanup({
        pause: true,
        cancelStarts: true,
        revokeControl: true,
      }),
      /binding changed/,
    );
    const row = (
      await pool.query(
        "SELECT control_enabled,verification FROM controller_state WHERE tenant_id=$1",
        [runtime.tenantId],
      )
    ).rows[0];
    assert.equal(row.control_enabled, true);
    assert.equal(row.verification.passed, true);
    assert.equal(row.verification.device, runtime.device);
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

async function capacityFixture(env = {}) {
  const appKey = apiAppKey(`capacity-${randomUUID()}`);
  await pool.query("INSERT INTO api_app_budgets (app_key) VALUES ($1)", [
    appKey,
  ]);
  for (const owner of [ids.alpha, ids.beta]) {
    await pool.query(
      "UPDATE controller_state SET control_enabled=false,paused=true,manual_topup=false,topup_expires_at=null,verification=null WHERE tenant_id=$1",
      [owner.tenant],
    );
    await pool.query(
      `UPDATE solarman_accounts SET api_app_key=$2,monitoring_admitted=false,validated_at=now(),
      device_sn=$3,discovered_devices=$4 WHERE tenant_id=$1`,
      [
        owner.tenant,
        appKey,
        owner.device,
        JSON.stringify([{ deviceSn: owner.device }]),
      ],
    );
  }
  // Separate instances exercise the database lock rather than the local task queue.
  return {
    appKey,
    budgets: [new ApiBudget(pool, env), new ApiBudget(pool, env)],
  };
}

test("concurrent monitoring admission cannot overbook a shared App ID and retries require no device access", async () => {
  const { appKey, budgets } = await capacityFixture({
    SOLARMAN_API_CALL_LIMIT: "30000",
  });
  const owners = [ids.alpha, ids.beta];
  const admissions = await Promise.all(
    owners.map((owner, index) =>
      budgets[index].register(appKey, owner.tenant, owner.account, {
        ready: true,
      }),
    ),
  );
  assert.equal(admissions.filter((result) => result.admitted).length, 1);
  const winner = admissions.findIndex((result) => result.admitted);
  const waiting = 1 - winner;
  const stored = (
    await pool.query(
      "SELECT monitoring_admitted,device_sn,discovered_devices FROM solarman_accounts WHERE id=$1",
      [owners[waiting].account],
    )
  ).rows[0];
  assert.equal(stored.monitoring_admitted, false);
  assert.equal(stored.device_sn, owners[waiting].device);
  assert.equal(stored.discovered_devices[0].deviceSn, owners[waiting].device);
  assert.equal(
    (
      await budgets[winner].register(
        appKey,
        owners[winner].tenant,
        owners[winner].account,
        { ready: false },
      )
    ).admitted,
    false,
  );
  assert.equal(
    (
      await budgets[waiting].register(
        appKey,
        owners[waiting].tenant,
        owners[waiting].account,
        { ready: true },
      )
    ).admitted,
    true,
  );
  const dto = budgets[waiting].capacityFor(appKey, owners[waiting].tenant);
  assert.equal(dto.monitoringWorkspaces, 1);
  assert.equal(dto.admitted, true);
  assert.equal(dto.controlAvailable, false);
  const serialized = JSON.stringify(dto);
  for (const owner of owners) {
    assert.equal(serialized.includes(owner.tenant), false);
    assert.equal(serialized.includes(owner.account), false);
    assert.equal(serialized.includes(owner.device), false);
  }
  assert.equal(serialized.includes(appKey), false);
});

test("concurrent control activation reserves paused control capacity and a separate App ID remains independent", async () => {
  const { appKey, budgets } = await capacityFixture();
  const owners = [ids.alpha, ids.beta];
  for (const [index, owner] of owners.entries())
    await budgets[index].register(appKey, owner.tenant, owner.account, {
      ready: true,
    });
  const requests = await Promise.all(
    owners.map(async (owner) => ({
      appKey,
      tenantId: owner.tenant,
      accountId: owner.account,
      device: owner.device,
      epoch: (
        await pool.query(
          "SELECT control_epoch::text AS epoch FROM controller_state WHERE tenant_id=$1",
          [owner.tenant],
        )
      ).rows[0].epoch,
    })),
  );
  const result = await Promise.allSettled(
    requests.map((request, index) => budgets[index].enableControl(request)),
  );
  assert.equal(
    result.filter((item) => item.status === "fulfilled" && item.value).length,
    1,
  );
  const rejected = result.find((item) => item.status === "rejected");
  assert.ok(rejected.reason instanceof ApiCapacityError);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::integer AS n FROM controller_state WHERE tenant_id=ANY($1::uuid[]) AND control_enabled AND paused",
        [owners.map((owner) => owner.tenant)],
      )
    ).rows[0].n,
    1,
  );
  const waiting = result.findIndex((item) => item.status === "rejected");
  const isolated = apiAppKey(`separate-${randomUUID()}`);
  assert.equal(
    (
      await budgets[waiting].register(
        isolated,
        owners[waiting].tenant,
        owners[waiting].account,
        { ready: true },
      )
    ).admitted,
    true,
  );
  assert.equal(
    await budgets[waiting].enableControl({
      ...requests[waiting],
      appKey: isolated,
    }),
    true,
  );
  // A committed Stop epoch must still prevent a delayed activation.
  await pool.query(
    "UPDATE controller_state SET control_enabled=false,control_epoch=control_epoch+1 WHERE tenant_id=$1",
    [owners[waiting].tenant],
  );
  assert.equal(
    await budgets[waiting].enableControl({
      ...requests[waiting],
      appKey: isolated,
    }),
    false,
  );
});

test("a capacity-waiting runtime makes no device assessment and resumes monitoring without enabling control", async () => {
  const { runtime, user, calls } = await controlFixture();
  try {
    runtime.hub.budget = new ApiBudget(pool, {
      SOLARMAN_API_CALL_LIMIT: "10000",
    });
    await runtime.requestCapacity();
    assert.equal(runtime.monitoringAdmitted, false);
    assert.equal(runtime.projectedCalls(), 0);
    const before = await runtime.health.initialize();
    const result = await runtime.collect();
    assert.equal(result.decision.reason, "monitoring_capacity_waiting");
    const after = await runtime.health.initialize();
    assert.deepEqual(after.attempted_at, before.attempted_at);
    assert.deepEqual(after.succeeded_at, before.succeeded_at);
    assert.deepEqual(calls, []);
    runtime.hub.budget = new ApiBudget(pool, {});
    assert.equal(
      (await completeCommand(runtime, "retry_capacity", user)).status,
      "succeeded",
    );
    assert.deepEqual(calls, []);
    assert.equal(runtime.monitoringAdmitted, true);
    assert.equal(runtime.projectedCalls(), 105120);
    assert.equal(runtime.controlEnabled, false);
    assert.equal(runtime.paused, true);
    await runtime.collect();
    assert.deepEqual(calls, ["provider-read"]);
    assert.ok((await runtime.health.initialize()).succeeded_at);
  } finally {
    await runtime.close();
  }
});

test("disabling control releases its reservation while failed cleanup survives restart and remains recoverable", async () => {
  const { runtime, user, calls } = await armedFixture();
  let restarted;
  try {
    await runtime.journal.prepare(206, [0, 25], null);
    runtime.controller.disable = async () => {
      throw new Error("Cleanup transport unavailable");
    };
    assert.equal(
      (await completeCommand(runtime, "disable_controls", user)).status,
      "failed",
    );
    assert.equal(runtime.controlEnabled, false);
    assert.equal(runtime.paused, true);
    assert.equal(runtime.journal.pending, true);
    assert.equal(runtime.capacity().controlWorkspaces, 0);
    assert.equal(runtime.readiness().canStop, true);
    assert.equal(runtime.readiness().canStart, false);
    const account = (
      await pool.query("SELECT * FROM solarman_accounts WHERE tenant_id=$1", [
        runtime.tenantId,
      ])
    ).rows[0];
    restarted = new TenantRuntime(runtime.hub, runtime.tenantId, account);
    await restarted.initialize();
    assert.equal(restarted.journal.pending, true);
    restarted.controller.disable = async () => {
      calls.push("recovered-disable");
      return 9;
    };
    assert.equal(
      (await completeCommand(restarted, "stop", user)).status,
      "succeeded",
    );
    assert.equal(restarted.journal.pending, false);
    assert.equal(restarted.controlEnabled, false);
    assert.equal(restarted.paused, true);
    assert.equal(restarted.readiness().canStart, false);
    assert.equal(
      calls.filter((call) => call === "recovered-disable").length,
      1,
    );
  } finally {
    await restarted?.close();
    await runtime.close();
  }
});

test("startup with a smaller allowance revokes saved activation without discarding its cleanup binding", async () => {
  const { runtime, user } = await armedFixture();
  let restarted;
  try {
    await runtime.journal.prepare(206, [0, 25], null);
    runtime.hub.budget = new ApiBudget(pool, {
      SOLARMAN_API_CALL_LIMIT: "10000",
    });
    const account = (
      await pool.query("SELECT * FROM solarman_accounts WHERE tenant_id=$1", [
        runtime.tenantId,
      ])
    ).rows[0];
    restarted = new TenantRuntime(runtime.hub, runtime.tenantId, account);
    await restarted.initialize();
    assert.equal(restarted.monitoringAdmitted, false);
    assert.equal(restarted.controlEnabled, false);
    assert.equal(restarted.paused, true);
    assert.equal(restarted.manualTopup, false);
    assert.equal(restarted.journal.pending, true);
    assert.equal(restarted.journal.context.device, runtime.device);
    assert.equal(restarted.readiness().canStop, true);
    restarted.controller.disable = async () => 9;
    assert.equal(
      (await completeCommand(restarted, "stop", user)).status,
      "succeeded",
    );
    assert.equal(restarted.journal.pending, false);
    assert.equal(restarted.monitoringAdmitted, false);
    assert.equal(restarted.controlEnabled, false);
  } finally {
    await restarted?.close();
    await runtime.close();
  }
});

async function securityUser(t) {
  const user = {
    id: randomUUID(),
    tenant: randomUUID(),
    email: `security-${randomUUID()}@example.test`,
  };
  await pool.query("INSERT INTO tenants (id,name) VALUES ($1,$2)", [
    user.tenant,
    "Security fixture",
  ]);
  await pool.query(
    "INSERT INTO users (id,tenant_id,email,password_hash) VALUES ($1,$2,$3,$4)",
    [user.id, user.tenant, user.email, await hashPassword(password)],
  );
  await pool.query("INSERT INTO controller_state (tenant_id) VALUES ($1)", [
    user.tenant,
  ]);
  t.after(async () => {
    await pool.query("DELETE FROM controller_state WHERE tenant_id=$1", [
      user.tenant,
    ]);
    await pool.query("DELETE FROM users WHERE id=$1", [user.id]);
    await pool.query("DELETE FROM tenants WHERE id=$1", [user.tenant]);
  });
  return user;
}

async function securityContext(auth) {
  return (
    await pool.query(
      "SELECT user_id AS id,id AS session_id,token_hash FROM sessions WHERE token_hash=$1",
      [tokenHash(auth.cookie.split("=")[1])],
    )
  ).rows[0];
}

test("password changes require the current password, rotate secrets, revoke other browsers and preserve other users", async (t) => {
  const user = await securityUser(t);
  const other = await securityUser(t);
  const current = await login(
    user.email,
    password,
    "integration-current-browser",
  );
  const second = await login(user.email, password, "integration-other-browser");
  const separate = await login(other.email);
  await pool.query(
    "UPDATE controller_state SET paused=false,control_enabled=true WHERE tenant_id=$1",
    [user.tenant],
  );
  assert.equal((await fetchApi("/security")).status, 401);
  const before = await (await fetchApi("/security", { auth: current })).json();
  assert.equal(before.sessionCount, 2);
  assert.equal(before.sessions.filter((s) => s.current).length, 1);
  const original = before.sessions.find((s) => s.current);
  const serialized = JSON.stringify(before);
  for (const secret of [
    password,
    current.csrfToken,
    current.cookie.split("=")[1],
    "token_hash",
    "csrf_token",
    "password_hash",
  ])
    assert.equal(serialized.includes(secret), false);
  const request = {
    auth: current,
    method: "POST",
    body: {
      currentPassword: password,
      newPassword: "replacement-with-space= ",
    },
  };
  assert.equal(
    (await fetchApi("/security/password", { ...request, csrf: false })).status,
    403,
  );
  assert.equal(
    (
      await fetchApi("/security/password", {
        ...request,
        body: { ...request.body, currentPassword: "incorrect" },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await fetchApi("/security/password", {
        ...request,
        body: { ...request.body, newPassword: "short" },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await fetchApi("/security/password", {
        ...request,
        body: { ...request.body, newPassword: password },
      })
    ).status,
    400,
  );
  assert.equal(
    (await (await fetchApi("/security", { auth: current })).json())
      .sessionCount,
    2,
  );
  const changed = await fetchApi("/security/password", request);
  assert.equal(changed.status, 200);
  const renewed = {
    ...(await changed.json()),
    cookie: changed.headers.get("set-cookie").split(";")[0],
  };
  assert.notEqual(renewed.cookie, current.cookie);
  assert.notEqual(renewed.csrfToken, current.csrfToken);
  assert.equal(
    (await fetchApi("/auth/session", { auth: current })).status,
    401,
  );
  assert.equal((await fetchApi("/auth/session", { auth: second })).status, 401);
  assert.equal(
    (await fetchApi("/auth/session", { auth: separate })).status,
    200,
  );
  const after = await (await fetchApi("/security", { auth: renewed })).json();
  assert.equal(after.sessionCount, 1);
  assert.equal(after.sessions[0].id, original.id);
  assert.equal(after.sessions[0].createdAt, original.createdAt);
  assert.ok(after.passwordChangedAt);
  assert.equal(
    after.events.find((e) => e.kind === "password_changed").affectedSessions,
    2,
  );
  assert.equal(
    (
      await fetchApi("/security/sessions/revoke-others", {
        auth: { ...renewed, csrfToken: current.csrfToken },
        method: "POST",
        body: {},
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetchApi("/security/sessions/revoke-others", {
        auth: renewed,
        method: "POST",
        body: {},
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await fetchApi("/auth/login", {
        method: "POST",
        body: { email: user.email, password },
      })
    ).status,
    401,
  );
  assert.ok((await login(user.email, request.body.newPassword)).cookie);
  const otherData = await (
    await fetchApi("/security", { auth: separate })
  ).json();
  assert.equal(
    JSON.stringify(otherData).includes(
      after.events.find((e) => e.kind === "password_changed").id,
    ),
    false,
  );
  assert.deepEqual(
    (
      await pool.query(
        "SELECT paused,control_enabled FROM controller_state WHERE tenant_id=$1",
        [user.tenant],
      )
    ).rows[0],
    { paused: false, control_enabled: true },
  );
  assert.equal(hub.runtimes.has(user.tenant), false);
});

test("browser revocation is scoped, retains the current browser, paginates and records no invented legacy activity", async (t) => {
  const user = await securityUser(t);
  const other = await securityUser(t);
  const current = await login(user.email, password, "x".repeat(400));
  const otherAuth = await login(other.email);
  const connection = await pool.connect();
  try {
    for (let i = 0; i < 22; i++)
      await createBrowserSession(
        connection,
        user.id,
        "fixture secondary browser",
      );
  } finally {
    connection.release();
  }
  const data = await (await fetchApi("/security", { auth: current })).json();
  assert.equal(data.sessionCount, 23);
  assert.equal(data.sessions.length, 20);
  assert.equal(data.hasMoreSessions, true);
  assert.equal(data.sessions[0].current, true);
  assert.equal(data.sessions[0].userAgent.length, 256);
  const target = data.sessions.find((s) => !s.current);
  await pool.query(
    "UPDATE sessions SET user_agent='',last_seen_at=null WHERE id=$1",
    [target.id],
  );
  const refreshed = await (
    await fetchApi("/security", { auth: current })
  ).json();
  assert.equal(
    refreshed.sessions.find((s) => s.id === target.id).lastSeenAt,
    null,
  );
  const page = await (
    await fetchApi("/security?offset=20", { auth: current })
  ).json();
  assert.equal(page.sessions.length, 3);
  assert.equal(page.hasMoreSessions, false);
  assert.equal(
    (await fetchApi("/security?offset=invalid", { auth: current })).status,
    400,
  );
  const revoke = { auth: current, method: "POST", body: { id: target.id } };
  assert.equal(
    (
      await fetchApi("/security/sessions/revoke", {
        ...revoke,
        auth: otherAuth,
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await fetchApi("/security/sessions/revoke", {
        ...revoke,
        body: { id: data.sessions[0].id },
      })
    ).status,
    400,
  );
  assert.equal(
    (await fetchApi("/security/sessions/revoke", revoke)).status,
    200,
  );
  assert.equal(
    (await fetchApi("/security/sessions/revoke", revoke)).status,
    404,
  );
  const ended = await fetchApi("/security/sessions/revoke-others", {
    auth: current,
    method: "POST",
    body: {},
  });
  assert.deepEqual(await ended.json(), { revoked: 21 });
  const remaining = await (
    await fetchApi("/security", { auth: current })
  ).json();
  assert.equal(remaining.sessionCount, 1);
  assert.equal(
    remaining.events.find((e) => e.kind === "other_sessions_revoked")
      .affectedSessions,
    21,
  );
  assert.equal((await fetchApi("/security", { auth: otherAuth })).status, 200);
  const old = new Date(Date.now() - 600000);
  await pool.query("UPDATE sessions SET last_seen_at=$2 WHERE id=$1", [
    data.sessions[0].id,
    old,
  ]);
  const seen = await (await fetchApi("/security", { auth: current })).json();
  assert.ok(new Date(seen.sessions[0].lastSeenAt) > old);
  assert.equal(
    (await (await fetchApi("/security", { auth: current })).json()).sessions[0]
      .lastSeenAt,
    seen.sessions[0].lastSeenAt,
  );
});

test("a delayed old-password login cannot recreate a revoked browser after a password change", async (t) => {
  const user = await securityUser(t);
  const current = await login(user.email);
  const snapshot = (
    await pool.query("SELECT id,password_hash FROM users WHERE id=$1", [
      user.id,
    ])
  ).rows[0];
  assert.equal(
    (
      await fetchApi("/security/password", {
        auth: current,
        method: "POST",
        body: {
          currentPassword: password,
          newPassword: "replacement-password",
        },
      })
    ).status,
    200,
  );
  const security = new AccountSecurity(pool);
  await assert.rejects(
    security.login(snapshot, "delayed browser"),
    (error) => error instanceof SecurityError && error.status === 401,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::integer AS n FROM sessions WHERE user_id=$1",
        [user.id],
      )
    ).rows[0].n,
    1,
  );
});

test("simultaneous password changes accept only one and a revoked session cannot mutate security", async (t) => {
  const user = await securityUser(t);
  const current = await login(user.email);
  const session = await securityContext(current);
  const first = new AccountSecurity(pool);
  const second = new AccountSecurity(pool);
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let arrived = 0;
  let ready;
  const bothReady = new Promise((resolve) => {
    ready = resolve;
  });
  for (const service of [first, second]) {
    const withUser = service.withUser.bind(service);
    service.withUser = async (...args) => {
      if (++arrived === 2) ready();
      await gate;
      return withUser(...args);
    };
  }
  const attempts = Promise.allSettled([
    first.changePassword(
      session,
      { currentPassword: password, newPassword: "first-replacement-password" },
      "first",
    ),
    second.changePassword(
      session,
      { currentPassword: password, newPassword: "second-replacement-password" },
      "second",
    ),
  ]);
  await bothReady;
  release();
  const results = await attempts;
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const failed = results.find((r) => r.status === "rejected");
  assert.ok(failed.reason instanceof SecurityError);
  assert.equal(failed.reason.status, 401);
  const security = new AccountSecurity(pool);
  await assert.rejects(
    security.revoke(session, null),
    (error) => error instanceof SecurityError && error.status === 401,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::integer AS n FROM sessions WHERE user_id=$1",
        [user.id],
      )
    ).rows[0].n,
    1,
  );
  // Logout accepted before rotation still ends that same public browser identity.
  await security.logout(session);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::integer AS n FROM sessions WHERE user_id=$1",
        [user.id],
      )
    ).rows[0].n,
    0,
  );
});

test("password reauthentication is rate-limited without ending the valid browser session", async (t) => {
  const user = await securityUser(t);
  const current = await login(user.email);
  for (let attempt = 0; attempt < 8; attempt++)
    assert.equal(
      (
        await fetchApi("/security/password", {
          auth: current,
          method: "POST",
          body: {
            currentPassword: "wrong-password",
            newPassword: "replacement-password",
          },
        })
      ).status,
      400,
    );
  const limited = await fetchApi("/security/password", {
    auth: current,
    method: "POST",
    body: { currentPassword: password, newPassword: "replacement-password" },
  });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "900");
  assert.equal((await fetchApi("/security", { auth: current })).status, 200);
});

async function savedRecoveryKey(auth, currentPassword = password) {
  const response = await fetchApi("/security/recovery/key", {
    auth,
    method: "POST",
    body: { currentPassword },
  });
  assert.equal(response.status, 200);
  return (await response.json()).key;
}
function privateToken(url, name = "key") {
  return new URLSearchParams(new URL(url).hash.slice(1)).get(name);
}
async function recoveryLink(email) {
  const response = await fetchApi("/admin/recovery", {
    auth: alpha,
    method: "POST",
    body: { email, currentPassword: password, action: "issue" },
  });
  assert.equal(response.status, 200);
  return await response.json();
}

test("saved recovery keys rotate, remain private and reset access without changing inverter intent", async (t) => {
  const user = await securityUser(t),
    other = await securityUser(t);
  const current = await login(user.email),
    second = await login(user.email),
    separate = await login(other.email);
  await pool.query(
    "UPDATE controller_state SET paused=false,control_enabled=true WHERE tenant_id=$1",
    [user.tenant],
  );
  assert.equal(
    (
      await fetchApi("/security/recovery/key", {
        auth: current,
        method: "POST",
        csrf: false,
        body: { currentPassword: password },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetchApi("/security/recovery/key", {
        auth: current,
        method: "POST",
        body: { currentPassword: "incorrect" },
      })
    ).status,
    400,
  );
  const first = await savedRecoveryKey(current),
    key = await savedRecoveryKey(current);
  assert.match(key, /^[a-f0-9]{64}$/);
  assert.notEqual(first, key);
  const metadata = await (
    await fetchApi("/security", { auth: current })
  ).json();
  assert.ok(metadata.recovery.keyCreatedAt);
  assert.equal(JSON.stringify(metadata).includes(key), false);
  const stored = (
    await pool.query(
      "SELECT token_hash FROM account_recovery_tokens WHERE user_id=$1 AND kind='saved_key' AND revoked_at IS NULL AND used_at IS NULL",
      [user.id],
    )
  ).rows[0];
  assert.equal(stored.token_hash, tokenHash(key));
  assert.notEqual(stored.token_hash, key);
  const admin = await recoveryLink(user.email);
  assert.equal(new URL(admin.url).search, "");
  assert.equal(privateToken(admin.url, "email"), user.email);
  const response = await fetchApi("/auth/recover", {
    method: "POST",
    clientIp: "198.51.100.41",
    body: { email: user.email, key, newPassword: "recovered-password= " },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("set-cookie"), null);
  const recovered = await response.json();
  assert.match(recovered.recoveryKey, /^[a-f0-9]{64}$/);
  assert.notEqual(recovered.recoveryKey, key);
  assert.equal(
    (await fetchApi("/auth/session", { auth: current })).status,
    401,
  );
  assert.equal((await fetchApi("/auth/session", { auth: second })).status, 401);
  assert.equal(
    (await fetchApi("/auth/session", { auth: separate })).status,
    200,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM sessions WHERE user_id=$1",
        [user.id],
      )
    ).rows[0].n,
    0,
  );
  for (const previous of [first, key, privateToken(admin.url)])
    assert.equal(
      (
        await fetchApi("/auth/recover", {
          method: "POST",
          clientIp: "198.51.100.41",
          body: {
            email: user.email,
            key: previous,
            newPassword: "another-replacement",
          },
        })
      ).status,
      400,
    );
  const renewed = await login(user.email, "recovered-password= ");
  const events = await (await fetchApi("/security", { auth: renewed })).json();
  assert.equal(
    events.events.find((event) => event.kind === "password_recovered")
      .affectedSessions,
    2,
  );
  assert.equal(JSON.stringify(events).includes(ids.alpha.user), false);
  const active = (
    await pool.query(
      "SELECT token_hash FROM account_recovery_tokens WHERE user_id=$1 AND used_at IS NULL AND revoked_at IS NULL",
      [user.id],
    )
  ).rows;
  assert.deepEqual(active, [{ token_hash: tokenHash(recovered.recoveryKey) }]);
  assert.deepEqual(
    (
      await pool.query(
        "SELECT paused,control_enabled FROM controller_state WHERE tenant_id=$1",
        [user.tenant],
      )
    ).rows[0],
    { paused: false, control_enabled: true },
  );
  assert.equal(hub.runtimes.has(user.tenant), false);
});

test("administrator recovery requires fresh credentials and cannot recover platform administrators", async (t) => {
  const user = await securityUser(t);
  const current = await login(user.email);
  assert.equal(
    (
      await fetchApi("/admin/recovery", {
        auth: current,
        method: "POST",
        body: { email: user.email, currentPassword: password, action: "issue" },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetchApi("/admin/recovery", {
        auth: alpha,
        method: "POST",
        csrf: false,
        body: { email: user.email, currentPassword: password, action: "issue" },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetchApi("/admin/recovery", {
        auth: alpha,
        method: "POST",
        body: {
          email: user.email,
          currentPassword: "incorrect",
          action: "issue",
        },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await fetchApi("/admin/recovery", {
        auth: alpha,
        method: "POST",
        body: {
          email: "alpha@example.test",
          currentPassword: password,
          action: "issue",
        },
      })
    ).status,
    404,
  );
  const saved = await savedRecoveryKey(current);
  const first = await recoveryLink(user.email),
    second = await recoveryLink(user.email);
  assert.ok(Date.parse(second.expiresAt) > Date.now() + 29 * 60000);
  assert.ok(Date.parse(second.expiresAt) < Date.now() + 31 * 60000);
  const reset = (key) =>
    fetchApi("/auth/recover", {
      method: "POST",
      clientIp: "198.51.100.42",
      body: { email: user.email, key, newPassword: "recovered-through-link" },
    });
  assert.equal((await reset(privateToken(first.url))).status, 400);
  assert.equal(
    (
      await fetchApi("/admin/recovery", {
        auth: alpha,
        method: "POST",
        body: {
          email: user.email,
          currentPassword: password,
          action: "revoke",
        },
      })
    ).status,
    200,
  );
  assert.equal((await reset(privateToken(second.url))).status, 400);
  const expired = await recoveryLink(user.email);
  await pool.query(
    "UPDATE account_recovery_tokens SET expires_at=now()-interval '1 second' WHERE token_hash=$1",
    [tokenHash(privateToken(expired.url))],
  );
  assert.equal((await reset(privateToken(expired.url))).status, 400);
  const beforeChange = await recoveryLink(user.email);
  const changed = await fetchApi("/security/password", {
    auth: current,
    method: "POST",
    body: { currentPassword: password, newPassword: "routine-replacement" },
  });
  assert.equal(changed.status, 200);
  const renewed = {
    ...(await changed.json()),
    cookie: changed.headers.get("set-cookie").split(";")[0],
  };
  assert.equal((await reset(privateToken(beforeChange.url))).status, 400);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM account_recovery_tokens WHERE user_id=$1 AND token_hash=$2 AND revoked_at IS NULL AND used_at IS NULL",
        [user.id, tokenHash(saved)],
      )
    ).rows[0].n,
    1,
  );
  const beforeNewKey = await recoveryLink(user.email);
  await savedRecoveryKey(renewed, "routine-replacement");
  assert.equal((await reset(privateToken(beforeNewKey.url))).status, 400);
  const promoted = await recoveryLink(user.email);
  await pool.query("UPDATE users SET platform_admin=true WHERE id=$1", [
    user.id,
  ]);
  assert.equal((await reset(privateToken(promoted.url))).status, 400);
});

test(
  "concurrent recovery consumption has one winner and delayed old-password logins cannot return",
  { timeout: 15000 },
  async (t) => {
    const user = await securityUser(t);
    const current = await login(user.email),
      key = await savedRecoveryKey(current);
    const original = (
      await pool.query("SELECT id,password_hash FROM users WHERE id=$1", [
        user.id,
      ])
    ).rows[0];
    let release,
      ready,
      arrived = 0;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const both = new Promise((resolve) => {
      ready = resolve;
    });
    t.after(() => release());
    const services = [new AccountRecovery(pool), new AccountRecovery(pool)];
    for (const service of services) {
      const locked = service.security.withUser.bind(service.security);
      service.security.withUser = async (...args) => {
        if (++arrived === 2) ready();
        await gate;
        return locked(...args);
      };
    }
    const results = Promise.allSettled(
      services.map((service, index) =>
        service.consume(user.email, key, `concurrent-replacement-${index}`),
      ),
    );
    await both;
    release();
    const outcomes = await results;
    assert.equal(
      outcomes.filter((outcome) => outcome.status === "fulfilled").length,
      1,
    );
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    assert.ok(rejected.reason instanceof SecurityError);
    assert.equal(rejected.reason.status, 400);
    await assert.rejects(
      new AccountSecurity(pool).login(original, "late browser"),
      (error) => error instanceof SecurityError && error.status === 401,
    );
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM sessions WHERE user_id=$1",
          [user.id],
        )
      ).rows[0].n,
      0,
    );
  },
);

test(
  "a delayed recovery-key issuance cannot outlive revocation of its browser",
  { timeout: 15000 },
  async (t) => {
    const user = await securityUser(t),
      current = await login(user.email);
    const key = await savedRecoveryKey(current),
      context = await securityContext(current);
    const service = new AccountRecovery(pool);
    let release, ready;
    const gate = new Promise((resolve) => {
        release = resolve;
      }),
      verified = new Promise((resolve) => {
        ready = resolve;
      });
    t.after(() => release());
    const confirm = service.security.confirmedPassword.bind(service.security);
    service.security.confirmedPassword = async (...args) => {
      const result = await confirm(...args);
      ready();
      await gate;
      return result;
    };
    const attempt = Promise.allSettled([service.createKey(context, password)]);
    await verified;
    await new AccountRecovery(pool).consume(
      user.email,
      key,
      "new-after-recovery",
    );
    release();
    const result = (await attempt)[0];
    assert.equal(result.status, "rejected");
    assert.equal(result.reason.status, 401);
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM account_recovery_tokens WHERE user_id=$1 AND used_at IS NULL AND revoked_at IS NULL",
          [user.id],
        )
      ).rows[0].n,
      1,
    );
  },
);

test("recovery rejects unknown details uniformly and bounds unauthenticated attempts", async (t) => {
  const user = await securityUser(t);
  const invalid = "a".repeat(64);
  const unknown = await fetchApi("/auth/recover", {
    method: "POST",
    clientIp: "198.51.100.44",
    body: {
      email: "unknown@example.test",
      key: invalid,
      newPassword: "replacement-password",
    },
  });
  const known = await fetchApi("/auth/recover", {
    method: "POST",
    clientIp: "198.51.100.45",
    body: {
      email: user.email,
      key: invalid,
      newPassword: "replacement-password",
    },
  });
  assert.equal(unknown.status, 400);
  assert.equal(known.status, 400);
  assert.deepEqual(await unknown.json(), await known.json());
  for (let i = 0; i < 8; i++)
    assert.equal(
      (
        await fetchApi("/auth/recover", {
          method: "POST",
          clientIp: "198.51.100.46",
          body: {
            email: user.email,
            key: invalid,
            newPassword: "replacement-password",
          },
        })
      ).status,
      400,
    );
  const limited = await fetchApi("/auth/recover", {
    method: "POST",
    clientIp: "198.51.100.46",
    body: {
      email: user.email,
      key: invalid,
      newPassword: "replacement-password",
    },
  });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "900");
});

test("operator recovery replaces credentials, revokes saved access and never creates a browser", async (t) => {
  const user = await securityUser(t),
    current = await login(user.email);
  const key = await savedRecoveryKey(current);
  await new AccountRecovery(pool).operatorReset(
    user.email,
    "operator-replacement",
  );
  assert.equal(
    (await fetchApi("/auth/session", { auth: current })).status,
    401,
  );
  assert.equal(
    (
      await fetchApi("/auth/recover", {
        method: "POST",
        clientIp: "198.51.100.47",
        body: { email: user.email, key, newPassword: "old-key-replay" },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM sessions WHERE user_id=$1",
        [user.id],
      )
    ).rows[0].n,
    0,
  );
  const auth = await login(user.email, "operator-replacement");
  assert.equal((await fetchApi("/security", { auth })).status, 200);
  assert.equal(
    (
      await pool.query(
        "SELECT actor_id FROM account_security_events WHERE user_id=$1 AND kind='password_recovered'",
        [user.id],
      )
    ).rows[0].actor_id,
    null,
  );
});

test("invitation history keeps bearer secrets private while revoke and reissue invalidate old links", async () => {
  const email = `lifecycle-${randomUUID()}@example.test`;
  const create = () =>
    fetchApi("/admin/invitations", {
      auth: alpha,
      method: "POST",
      body: { email, tenantName: "Invitation lifecycle" },
    });
  const created = await create();
  assert.equal(created.status, 201);
  const first = await created.json();
  assert.equal(new URL(first.url).search, "");
  const token = privateToken(first.url, "token");
  assert.match(token, /^[a-f0-9]{64}$/);
  assert.equal((await create()).status, 409);
  assert.equal(
    (await fetchApi("/admin/invitations", { auth: beta })).status,
    403,
  );
  const list = await (
    await fetchApi("/admin/invitations", { auth: alpha })
  ).json();
  assert.equal(JSON.stringify(list).includes(token), false);
  assert.equal(JSON.stringify(list).includes("token_hash"), false);
  assert.equal(
    (await fetchApi("/invitation/inspect", { method: "POST", body: { token } }))
      .status,
    200,
  );
  assert.equal(
    (
      await fetchApi(`/admin/invitations/${first.id}/revoke`, {
        auth: alpha,
        method: "POST",
        csrf: false,
        body: {},
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetchApi(`/admin/invitations/${first.id}/revoke`, {
        auth: alpha,
        method: "POST",
        body: {},
      })
    ).status,
    200,
  );
  assert.equal(
    (await fetchApi("/invitation/inspect", { method: "POST", body: { token } }))
      .status,
    404,
  );
  assert.equal(
    (
      await fetchApi("/auth/activate", {
        method: "POST",
        body: { token, password },
      })
    ).status,
    400,
  );
  const renewed = await fetchApi(`/admin/invitations/${first.id}/reissue`, {
    auth: alpha,
    method: "POST",
    body: {},
  });
  assert.equal(renewed.status, 200);
  const second = await renewed.json();
  assert.notEqual(second.id, first.id);
  assert.notEqual(privateToken(second.url, "token"), token);
  assert.equal(
    (
      await fetchApi(`/admin/invitations/${first.id}/reissue`, {
        auth: alpha,
        method: "POST",
        body: {},
      })
    ).status,
    409,
  );
  const parallel = await Promise.all(
    [0, 1].map(() =>
      fetchApi(`/admin/invitations/${second.id}/reissue`, {
        auth: alpha,
        method: "POST",
        body: {},
      }),
    ),
  );
  assert.deepEqual(parallel.map((r) => r.status).sort(), [200, 409]);
  const final = await parallel.find((r) => r.status === 200).json();
  assert.equal(
    (
      await fetchApi("/auth/activate", {
        method: "POST",
        body: { token: privateToken(final.url, "token"), password },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await fetchApi(`/admin/invitations/${final.id}/revoke`, {
        auth: alpha,
        method: "POST",
        body: {},
      })
    ).status,
    409,
  );
  assert.equal((await create()).status, 409);
  const stored = (
    await pool.query(
      "SELECT revoked_at,replaced_by_id FROM invitations WHERE id=$1",
      [first.id],
    )
  ).rows[0];
  assert.ok(stored.revoked_at);
  assert.equal(stored.replaced_by_id, second.id);
});

test(
  "invitation activation and revocation serialize on the email and leave one outcome",
  { timeout: 15000 },
  async () => {
    const email = `race-${randomUUID()}@example.test`;
    const first = await (
      await fetchApi("/admin/invitations", {
        auth: alpha,
        method: "POST",
        body: { email, tenantName: "Invitation race" },
      })
    ).json();
    const connection = await pool.connect();
    let attempts;
    try {
      await connection.query("BEGIN");
      await lockInvitationEmail(connection, email);
      const activated = fetchApi("/auth/activate", {
        method: "POST",
        body: { token: privateToken(first.url, "token"), password },
      });
      const revoked = fetchApi(`/admin/invitations/${first.id}/revoke`, {
        auth: alpha,
        method: "POST",
        body: {},
      });
      attempts = Promise.all([activated, revoked]);
      let waiting = false;
      for (let i = 0; i < 100; i++) {
        const count = (
          await pool.query(
            "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%pg_advisory_xact_lock(193402,%' AND pid<>pg_backend_pid()",
          )
        ).rows[0].n;
        if (count >= 2) {
          waiting = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(waiting, true);
    } finally {
      await connection.query("ROLLBACK");
      connection.release();
    }
    const [activated, revoked] = await attempts;
    assert.ok(
      (activated.status === 200 && revoked.status === 409) ||
        (activated.status === 400 && revoked.status === 200),
    );
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM users WHERE lower(email)=$1",
          [email],
        )
      ).rows[0].n,
      activated.status === 200 ? 1 : 0,
    );
  },
);

test("private-access migration preserves invitation history while retiring duplicate pending links", async () => {
  const connection = await pool.connect();
  const schema = `access_fixture_${randomUUID().replaceAll("-", "")}`;
  try {
    await connection.query("BEGIN");
    await connection.query(`CREATE SCHEMA "${schema}"`);
    await connection.query(`SET LOCAL search_path="${schema}",pg_catalog`);
    await connection.query(`CREATE TABLE users (id uuid PRIMARY KEY,email text NOT NULL);
      CREATE TABLE account_security_events (kind text CONSTRAINT account_security_events_kind_check CHECK (kind IN ('signed_in')));
      CREATE TABLE invitations (token_hash text PRIMARY KEY,email text NOT NULL,tenant_name text,created_at timestamptz NOT NULL,used_at timestamptz);`);
    await connection.query(
      "INSERT INTO users VALUES ($1,'existing@example.test')",
      [randomUUID()],
    );
    await connection.query(`INSERT INTO invitations VALUES
      ('older','DUPLICATE@example.test','Original',now()-interval '2 hours',null),
      ('newer','duplicate@example.test','Latest',now()-interval '1 hour',null),
      ('used','accepted@example.test','Accepted',now()-interval '3 hours',now()-interval '2 hours'),
      ('existing','existing@example.test','Existing account',now(),null)`);
    await connection.query(
      await readFile(
        new URL("../../migrations/013_private_access.sql", import.meta.url),
        "utf8",
      ),
    );
    const rows = (
      await connection.query(
        "SELECT token_hash,id,tenant_name,used_at,revoked_at,replaced_by_id FROM invitations ORDER BY token_hash",
      )
    ).rows;
    assert.equal(rows.length, 4);
    const old = rows.find((row) => row.token_hash === "older"),
      latest = rows.find((row) => row.token_hash === "newer");
    assert.ok(old.revoked_at);
    assert.equal(old.replaced_by_id, latest.id);
    assert.equal(latest.revoked_at, null);
    assert.equal(old.tenant_name, "Original");
    assert.equal(latest.tenant_name, "Latest");
    assert.ok(rows.find((row) => row.token_hash === "used").used_at);
    assert.equal(
      rows.find((row) => row.token_hash === "used").revoked_at,
      null,
    );
    assert.ok(rows.find((row) => row.token_hash === "existing").revoked_at);
  } finally {
    await connection.query("ROLLBACK");
    connection.release();
  }
});

test(
  "recovery expiry uses the authorization time after a blocked user lock",
  { timeout: 15000 },
  async (t) => {
    const user = await securityUser(t),
      current = await login(user.email),
      issued = await recoveryLink(user.email);
    const service = new AccountRecovery(pool),
      connection = await pool.connect();
    let pending;
    try {
      await connection.query("BEGIN");
      const blocker = (await connection.query("SELECT pg_backend_pid() AS id"))
        .rows[0].id;
      await connection.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [
        user.id,
      ]);
      pending = Promise.allSettled([
        service.consume(
          user.email,
          privateToken(issued.url),
          "expired-while-waiting",
        ),
      ]);
      let waiting = false;
      for (let i = 0; i < 100; i++) {
        const rows = (
          await pool.query(
            "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(pid))",
            [blocker],
          )
        ).rows;
        if (rows[0].n > 0) {
          waiting = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(waiting, true);
      await connection.query(
        "UPDATE account_recovery_tokens SET expires_at=clock_timestamp()+interval '100 milliseconds' WHERE token_hash=$1",
        [tokenHash(privateToken(issued.url))],
      );
      await connection.query("SELECT pg_sleep(0.15)");
      await connection.query("COMMIT");
    } finally {
      await connection.query("ROLLBACK");
      connection.release();
    }
    const outcome = (await pending)[0];
    assert.equal(outcome.status, "rejected");
    assert.equal(outcome.reason.status, 400);
    assert.equal(
      (await fetchApi("/auth/session", { auth: current })).status,
      200,
    );
  },
);

async function lifecycleFixture() {
  const actor = { tenant: randomUUID(), user: randomUUID() };
  const target = {
    tenant: randomUUID(),
    user: randomUUID(),
    account: randomUUID(),
    device: `lifecycle-${randomUUID()}`,
  };
  const email = `lifecycle-admin-${actor.user}@example.test`;
  const targetEmail = `lifecycle-member-${target.user}@example.test`;
  const hash = await hashPassword(password);
  for (const [owner, admin, address] of [
    [actor, true, email],
    [target, false, targetEmail],
  ]) {
    await pool.query("INSERT INTO tenants(id,name) VALUES ($1,$2)", [
      owner.tenant,
      admin ? "Lifecycle administrator" : "Lifecycle member",
    ]);
    await pool.query(
      "INSERT INTO users(id,tenant_id,email,password_hash,platform_admin) VALUES ($1,$2,$3,$4,$5)",
      [owner.user, owner.tenant, address, hash, admin],
    );
    await pool.query("INSERT INTO controller_state(tenant_id) VALUES ($1)", [
      owner.tenant,
    ]);
  }
  await pool.query(
    `INSERT INTO solarman_accounts(id,tenant_id,email,credentials,device_sn,profile,discovered_devices,validated_at) VALUES ($1,$2,$3,$4,$5,'bluesun-bse20kh3',$6,now())`,
    [
      target.account,
      target.tenant,
      targetEmail,
      encryptCredentials(
        {
          passwordSha256: "a".repeat(64),
          appId: `lifecycle-${target.tenant}`,
          appSecret: "isolated-fixture",
        },
        key,
        target.tenant,
        target.account,
      ),
      target.device,
      JSON.stringify([{ deviceSn: target.device, stationId: 1 }]),
    ],
  );
  const admin = await login(email);
  const member = await login(targetEmail);
  const session = {
    id: actor.user,
    token_hash: tokenHash(admin.cookie.split("=")[1]),
  };
  return {
    actor,
    target,
    admin,
    member,
    session,
    lifecycle: new TenantLifecycle(pool),
  };
}

function lifecycleBody(state = "suspended", revision = "0") {
  return {
    state,
    revision,
    currentPassword: password,
    message: "Member-visible fixture message",
  };
}

test("workspace lifecycle requires administrator reauthentication, CSRF, current revision and a non-administrator target", async () => {
  const f = await lifecycleFixture();
  const route = `/admin/tenants/${f.target.tenant}/lifecycle`;
  assert.equal(
    (
      await fetchApi(route, {
        auth: f.member,
        method: "POST",
        body: lifecycleBody(),
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetchApi(route, {
        auth: f.admin,
        method: "POST",
        body: lifecycleBody(),
        csrf: false,
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetchApi(route, {
        auth: f.admin,
        method: "POST",
        body: { ...lifecycleBody(), currentPassword: "wrong" },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await fetchApi(route, {
        auth: f.admin,
        method: "POST",
        body: lifecycleBody("suspended", "9"),
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await fetchApi(`/admin/tenants/${f.actor.tenant}/lifecycle`, {
        auth: f.admin,
        method: "POST",
        body: lifecycleBody(),
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await fetchApi(route, {
        auth: f.admin,
        method: "POST",
        body: { ...lifecycleBody(), state: "offboarding" },
      })
    ).status,
    400,
  );
  const response = await fetchApi(route, {
    auth: f.admin,
    method: "POST",
    body: lifecycleBody(),
  });
  assert.equal(response.status, 200);
  const saved = await response.json();
  assert.equal(saved.state, "suspended");
  assert.equal(saved.revision, "1");
  assert.equal(saved.events.length, 1);
  assert.equal(
    (
      await fetchApi(route, {
        auth: f.admin,
        method: "POST",
        body: lifecycleBody("active"),
      })
    ).status,
    409,
  );
  assert.equal(
    (await fetchApi("/workspace/lifecycle", { auth: f.member })).status,
    200,
  );
  assert.equal(
    (
      await fetchApi(`/admin/tenants/${f.actor.tenant}/lifecycle`, {
        auth: f.member,
      })
    ).status,
    403,
  );
  assert.equal((await fetchApi("/overview", { auth: f.member })).status, 200);
  assert.equal((await fetchApi("/security", { auth: f.member })).status, 200);
  const own = await (
    await fetchApi("/workspace/lifecycle", { auth: f.member })
  ).json();
  assert.equal(own.message, "Member-visible fixture message");
  const serialized = JSON.stringify(own);
  assert.equal(serialized.includes(f.actor.user), false);
  assert.equal(serialized.includes(f.actor.tenant), false);
});

test("suspension cancels queued starts, persists cleanup and preserves provider credentials and other tenants", async () => {
  const f = await lifecycleFixture();
  const before = (
    await pool.query(
      "SELECT credentials FROM solarman_accounts WHERE tenant_id=$1",
      [f.target.tenant],
    )
  ).rows[0].credentials;
  await pool.query(
    "UPDATE controller_state SET control_enabled=true,paused=false,manual_topup=true,topup_expires_at=now()+interval '1 hour',verification='{}' WHERE tenant_id=$1",
    [f.target.tenant],
  );
  const queued = randomUUID();
  await pool.query(
    "INSERT INTO command_executions(id,tenant_id,actor,action,status) VALUES ($1,$2,'fixture','topup','queued')",
    [queued, f.target.tenant],
  );
  await f.lifecycle.change(f.session, f.target.tenant, lifecycleBody());
  const control = (
    await pool.query("SELECT * FROM controller_state WHERE tenant_id=$1", [
      f.target.tenant,
    ])
  ).rows[0];
  assert.equal(control.control_enabled, false);
  assert.equal(control.paused, true);
  assert.equal(control.manual_topup, false);
  assert.equal(control.verification, null);
  assert.equal(control.topup_expires_at, null);
  assert.equal(control.control_epoch, "1");
  assert.equal(
    (
      await pool.query("SELECT status FROM command_executions WHERE id=$1", [
        queued,
      ])
    ).rows[0].status,
    "interrupted",
  );
  assert.equal(
    (await f.lifecycle.status(f.target.tenant)).cleanupPending,
    true,
  );
  assert.deepEqual(
    (
      await pool.query(
        "SELECT credentials FROM solarman_accounts WHERE tenant_id=$1",
        [f.target.tenant],
      )
    ).rows[0].credentials,
    before,
  );
  assert.equal((await f.lifecycle.status(f.actor.tenant)).state, "active");
  const journal = new ControlJournal(pool, {
    tenantId: f.target.tenant,
    accountId: f.target.account,
    device: f.target.device,
  });
  await assert.rejects(journal.prepare(206, [0, 25], null), /blocked/);
  await assert.rejects(
    journal.authorizeDispatch("011000CE00020400000019BFB9"),
    /blocked/,
  );
  const off = "011000CE00020400000009BE75";
  await journal.authorizeDispatch(off);
  const write = await journal.prepare(206, [0, 9], null);
  await journal.verify(write);
  assert.equal(
    (await f.lifecycle.status(f.target.tenant)).cleanupPending,
    false,
  );
});

test("workspace resumption preserves pause, requires fresh verification and retains cleanup across restart", async () => {
  const f = await lifecycleFixture();
  const { runtime, user, calls } = await controlFixture(true, f.target);
  let restarted;
  try {
    await completeCommand(runtime, "verify", user);
    await completeCommand(runtime, "enable_controls", user);
    await completeCommand(runtime, "resume", user);
    const staleEpoch = (
      await pool.query(
        "SELECT control_epoch::text FROM controller_state WHERE tenant_id=$1",
        [f.target.tenant],
      )
    ).rows[0].control_epoch;
    const owned = await runtime.journal.prepare(206, [0, 25], null);
    await runtime.journal.verify(owned);
    const pending = await runtime.journal.prepare(
      2509,
      [1, 10, 0, 0, 0, 0, 0, 0],
      null,
    );
    await f.lifecycle.change(f.session, f.target.tenant, lifecycleBody());
    // A late readback cannot remove the suspension's cleanup obligation.
    await runtime.journal.verify(pending);
    runtime.controller.disable = async () => {
      throw new Error("Isolated cleanup outage");
    };
    await AccountHub.prototype.lifecycleChanged.call(
      {
        runtimes: new Map([[f.target.tenant, runtime]]),
        budget: runtime.hub.budget,
      },
      f.target.tenant,
      runtime.appKey,
    );
    await runtime.work.idle();
    assert.equal(runtime.lifecycle, "suspended");
    assert.equal(runtime.journal.pending, true);
    assert.equal(runtime.capacity().controlWorkspaces, 0);
    assert.equal(runtime.readiness().canStart, false);
    assert.equal(runtime.readiness().canStop, true);
    for (const action of ["resume", "topup", "enable_controls"])
      await assert.rejects(
        runtime.submit(action, user, randomUUID()),
        /suspended/,
      );
    assert.equal(await runtime.applyStartIntent("resume", staleEpoch), false);
    await assert.rejects(
      runtime.journal.authorizeDispatch("011000CE00020400000019BFB9"),
      /blocked/,
    );
    const account = (
      await pool.query("SELECT * FROM solarman_accounts WHERE tenant_id=$1", [
        f.target.tenant,
      ])
    ).rows[0];
    restarted = new TenantRuntime(runtime.hub, f.target.tenant, account);
    await restarted.initialize();
    assert.equal(restarted.lifecycle, "suspended");
    assert.equal(restarted.journal.pending, true);
    restarted.controller.disable = async () => {
      calls.push("lifecycle-recovery-off");
      return 9;
    };
    assert.equal(
      (await completeCommand(restarted, "stop", user)).status,
      "succeeded",
    );
    assert.equal(restarted.journal.pending, false);
    await f.lifecycle.change(
      f.session,
      f.target.tenant,
      lifecycleBody("active", "1"),
    );
    await restarted.initialize();
    assert.equal(restarted.lifecycle, "active");
    assert.equal(restarted.controlEnabled, false);
    assert.equal(restarted.paused, true);
    assert.equal(restarted.verification, null);
    await assert.rejects(
      restarted.submit("resume", user, randomUUID()),
      /verified/,
    );
    const events = (await f.lifecycle.status(f.target.tenant)).events;
    assert.deepEqual(
      events.map((e) => e.state),
      ["active", "suspended"],
    );
    assert.ok(calls.includes("lifecycle-recovery-off"));
  } finally {
    await restarted?.close();
    await runtime.close();
  }
});

test("concurrent workspace changes accept one revision and never duplicate lifecycle history", async () => {
  const f = await lifecycleFixture();
  const other = await lifecycleFixture();
  const results = await Promise.allSettled([
    other.lifecycle.change(other.session, f.target.tenant, lifecycleBody()),
    f.lifecycle.change(f.session, f.target.tenant, lifecycleBody()),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const failure = results.find((r) => r.status === "rejected");
  assert.equal(failure.reason.status, 409);
  const status = await f.lifecycle.status(f.target.tenant);
  assert.equal(status.events.length, 1);
  assert.equal(status.revision, "1");
  assert.equal(
    (
      await f.lifecycle.change(
        f.session,
        f.target.tenant,
        lifecycleBody("suspended", "1"),
      )
    ).changed,
    false,
  );
  assert.equal((await f.lifecycle.status(f.target.tenant)).events.length, 1);
});

test("suspension defeats a delayed capacity activation from an independent planner", async () => {
  const f = await lifecycleFixture();
  const { runtime } = await controlFixture(true, f.target);
  try {
    const request = {
      appKey: runtime.appKey,
      tenantId: f.target.tenant,
      accountId: f.target.account,
      device: f.target.device,
      epoch: "0",
    };
    await f.lifecycle.change(f.session, f.target.tenant, lifecycleBody());
    const independent = new ApiBudget(pool, {});
    assert.equal(await independent.enableControl(request), false);
    // Even a caller holding the new epoch cannot activate a suspended tenant.
    assert.equal(
      await independent.enableControl({ ...request, epoch: "1" }),
      false,
    );
    const state = (
      await pool.query(
        "SELECT control_enabled,paused FROM controller_state WHERE tenant_id=$1",
        [f.target.tenant],
      )
    ).rows[0];
    assert.deepEqual(state, { control_enabled: false, paused: true });
  } finally {
    await runtime.close();
  }
});

test("suspended administrators cannot create invitations or recovery links", async () => {
  const f = await lifecycleFixture();
  // Simulate an operator-applied suspension; the panel itself protects admin workspaces.
  await pool.query("UPDATE tenants SET lifecycle='suspended' WHERE id=$1", [
    f.actor.tenant,
  ]);
  const address = `suspended-invite-${randomUUID()}@example.test`;
  await assert.rejects(
    new Invitations(pool).create(f.session, {
      email: address,
      tenantName: "Denied",
    }),
    /suspended/,
  );
  const memberEmail = (
    await pool.query("SELECT email FROM users WHERE id=$1", [f.target.user])
  ).rows[0].email;
  await assert.rejects(
    new AccountRecovery(pool).administrative(f.session, {
      email: memberEmail,
      currentPassword: password,
      action: "issue",
    }),
    /suspended/,
  );
  assert.equal((await fetchApi("/security", { auth: f.admin })).status, 200);
});

test("workspace suspension interrupts an already queued runtime start before device work", async () => {
  const f = await lifecycleFixture();
  const { runtime, user, calls } = await controlFixture(true, f.target);
  let release;
  try {
    await completeCommand(runtime, "verify", user);
    await completeCommand(runtime, "enable_controls", user);
    const blocker = runtime.queue(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    while (!release) await new Promise((resolve) => setImmediate(resolve));
    const job = await runtime.submit("resume", user, randomUUID());
    const before = calls.length;
    await f.lifecycle.change(f.session, f.target.tenant, lifecycleBody());
    await AccountHub.prototype.lifecycleChanged.call(
      {
        runtimes: new Map([[f.target.tenant, runtime]]),
        budget: runtime.hub.budget,
      },
      f.target.tenant,
      runtime.appKey,
    );
    release();
    await blocker;
    await runtime.work.idle();
    const saved = (
      await pool.query("SELECT status FROM command_executions WHERE id=$1", [
        job.id,
      ])
    ).rows[0];
    assert.equal(saved.status, "interrupted");
    assert.deepEqual(calls.slice(before), ["disable"]);
    assert.equal(runtime.paused, true);
    assert.equal(runtime.controlEnabled, false);
  } finally {
    release?.();
    await runtime.close();
  }
});

test("workspace history retains the newest twenty numeric revisions without exposing administrator identifiers", async () => {
  const f = await lifecycleFixture();
  await pool.query(
    `INSERT INTO tenant_lifecycle_events(tenant_id,revision,state,message,actor_id) SELECT $1,n,CASE WHEN n%2=0 THEN 'active' ELSE 'suspended' END,'History fixture',$2 FROM generate_series(1,30) n`,
    [f.target.tenant, f.actor.user],
  );
  const status = await f.lifecycle.status(f.target.tenant);
  assert.deepEqual(
    status.events.map((event) => event.revision),
    Array.from({ length: 20 }, (_, i) => String(30 - i)),
  );
  assert.equal(JSON.stringify(status).includes(f.actor.user), false);
});

async function dataFixture() {
  const f = await lifecycleFixture();
  return {
    ...f,
    data: new WorkspaceData(pool),
    memberSession: {
      id: f.target.user,
      tenant_id: f.target.tenant,
      token_hash: tokenHash(f.member.cookie.split("=")[1]),
    },
  };
}
function retentionBody(overrides = {}) {
  return {
    currentPassword: password,
    enabled: true,
    measurementDays: 365,
    activityDays: 30,
    revision: "0",
    ...overrides,
  };
}
async function dataMeasurement(owner, daysAgo, number = 1) {
  return (
    await pool.query(
      `INSERT INTO measurements(tenant_id,account_id,device,observed_at,soc,temperature_c,pv_w,load_w,grid_w,battery_w,ac_enabled,snapshot)
    SELECT $1,$2,$3,clock_timestamp()-$4*interval '1 day'-n*interval '1 second',50,20,1234,1000,0,-234,false,'{}' FROM generate_series(1,$5) n RETURNING id::text`,
      [owner.tenant, owner.account, owner.device, daysAgo, number],
    )
  ).rows.map((row) => row.id);
}

test("workspace retention is opt-in, scoped, reauthenticated, revision checked and available during suspension", async () => {
  const f = await dataFixture();
  const initial = await (
    await fetchApi("/workspace/retention", { auth: f.member })
  ).json();
  assert.equal(initial.enabled, false);
  assert.equal(initial.measurementDays, 365);
  assert.equal(initial.activityDays, 730);
  assert.equal(initial.revision, "0");
  assert.equal(await new DataMaintenance(pool).runOnce(f.target.tenant), null);
  assert.equal(
    (
      await fetchApi("/workspace/retention", {
        auth: f.member,
        method: "POST",
        body: retentionBody(),
        csrf: false,
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetchApi("/workspace/retention", {
        auth: f.member,
        method: "POST",
        body: retentionBody({ currentPassword: "wrong" }),
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await fetchApi("/workspace/retention", {
        auth: f.member,
        method: "POST",
        body: retentionBody({ activityDays: 29 }),
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await fetchApi("/workspace/retention", {
        auth: f.member,
        method: "POST",
        body: retentionBody({ measurementDays: 3651 }),
      })
    ).status,
    400,
  );
  const saved = await fetchApi("/workspace/retention", {
    auth: f.member,
    method: "POST",
    body: retentionBody({ tenantId: f.actor.tenant }),
  });
  assert.equal(saved.status, 200);
  const policy = await saved.json();
  assert.equal(policy.enabled, true);
  assert.equal(policy.revision, "1");
  assert.equal(policy.events.length, 1);
  assert.equal((await f.data.retention(f.actor.tenant)).enabled, false);
  assert.equal(
    (
      await fetchApi("/workspace/retention", {
        auth: f.member,
        method: "POST",
        body: retentionBody(),
      })
    ).status,
    409,
  );
  await f.lifecycle.change(f.session, f.target.tenant, lifecycleBody());
  assert.equal(
    (
      await f.data.updateRetention(
        f.memberSession,
        retentionBody({ revision: "1", enabled: false }),
      )
    ).revision,
    "2",
  );
  assert.equal((await f.lifecycle.status(f.target.tenant)).state, "suspended");
});

test("workspace archives contain complete tenant data and a checksum without credentials, browser secrets or another users security metadata", async () => {
  const f = await dataFixture();
  await pool.query(
    "INSERT INTO device_health(tenant_id,account_id,device,control_fault) VALUES($1,$2,$3,true)",
    [f.target.tenant, f.target.account, f.target.device],
  );
  await dataMeasurement(f.target, 1, 3);
  await dataMeasurement(ids.alpha, 1);
  const savedKey = await new AccountRecovery(pool).createKey(
    f.memberSession,
    password,
  );
  const otherUser = randomUUID();
  const hash = await hashPassword(password);
  await pool.query(
    "INSERT INTO users(id,tenant_id,email,password_hash) VALUES($1,$2,$3,$4)",
    [
      otherUser,
      f.target.tenant,
      `archive-other-${otherUser}@example.test`,
      hash,
    ],
  );
  const client = await pool.connect();
  let other;
  try {
    other = await createBrowserSession(
      client,
      otherUser,
      "PRIVATE-OTHER-BROWSER",
    );
  } finally {
    client.release();
  }
  assert.equal(
    (
      await fetchApi("/workspace/archive", {
        auth: f.member,
        method: "POST",
        body: { currentPassword: password },
        csrf: false,
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetchApi("/workspace/archive", {
        auth: f.member,
        method: "POST",
        body: { currentPassword: "wrong" },
      })
    ).status,
    400,
  );
  const response = await fetchApi("/workspace/archive", {
    auth: f.member,
    method: "POST",
    body: { currentPassword: password, tenantId: ids.alpha.tenant },
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /ndjson/);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const text = await response.text();
  const lines = text.trimEnd().split("\n");
  const entries = lines.map((line) => JSON.parse(line));
  const footer = entries.at(-1);
  assert.equal(entries[0].type, "manifest");
  assert.equal(footer.type, "complete");
  assert.equal(footer.counts.measurements, 3);
  assert.equal(footer.counts.members, 2);
  assert.equal(footer.counts.deviceHealth, 1);
  assert.equal(
    entries.find((row) => row.section === "deviceHealth").data.control_fault,
    true,
  );
  assert.equal(
    footer.sha256,
    createHash("sha256")
      .update(lines.slice(0, -1).join("\n") + "\n")
      .digest("hex"),
  );
  for (const forbidden of [
    ids.alpha.tenant,
    ids.alpha.device,
    hash,
    f.member.csrfToken,
    other.token,
    "PRIVATE-OTHER-BROWSER",
    savedKey.key,
    "password_hash",
    "token_hash",
    "csrf_token",
    "passwordSha256",
    "isolated-fixture",
  ])
    assert.equal(
      text.includes(forbidden),
      false,
      forbidden === "PRIVATE-OTHER-BROWSER"
        ? "Other browser metadata leaked"
        : "Private data leaked",
    );
  assert.equal(
    entries
      .filter((row) => row.section === "browserSessions")
      .every((row) => row.data.user_agent !== "PRIVATE-OTHER-BROWSER"),
    true,
  );
  for (const section of entries[0].sections)
    assert.equal(
      footer.counts[section],
      entries.filter((row) => row.section === section).length,
    );
});

async function archiveServer(data, session) {
  let finished;
  const done = new Promise((resolve) => {
    finished = resolve;
  });
  const http = createServer((request, response) => {
    void data
      .archive(session, password, response)
      .catch((error) => {
        if (!response.headersSent && !response.destroyed) {
          response.writeHead(error.status ?? 500, {
            "content-type": "application/json",
          });
          response.end(JSON.stringify({ error: "Archive rejected" }));
        }
      })
      .finally(() => finished());
  });
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${http.address().port}`,
    done,
    close: () =>
      new Promise((resolve) => {
        http.close(resolve);
        http.closeIdleConnections();
      }),
  };
}

test("archive snapshots remain consistent while new readings arrive and a second export for the workspace is refused", async () => {
  const f = await dataFixture();
  await dataMeasurement(f.target, 1, 2);
  let release;
  let entered;
  const blocked = new Promise((resolve) => {
    entered = resolve;
  });
  const wait = new Promise((resolve) => {
    release = resolve;
  });
  let first = true;
  const proxy = {
    query: pool.query.bind(pool),
    connect: async () => {
      const client = await pool.connect();
      return {
        release: client.release.bind(client),
        query: async (...args) => {
          const result = await client.query(...args);
          if (first && String(args[0]).startsWith("FETCH")) {
            first = false;
            entered();
            await wait;
          }
          return result;
        },
      };
    },
  };
  const data = new WorkspaceData(proxy, { batchRows: 1 });
  const http = await archiveServer(data, f.memberSession);
  try {
    const response = await fetch(http.url);
    const output = response.text();
    await blocked;
    const other = await fetch(http.url);
    assert.equal(other.status, 429);
    await other.text();
    await dataMeasurement(f.target, 0, 1);
    release();
    const entries = (await output)
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(entries.at(-1).counts.measurements, 2);
    await http.done;
    assert.equal(data.exports.size, 0);
  } finally {
    release();
    await http.close();
  }
});

test("revoking a browser during an archive aborts the stream and releases its database connection", async () => {
  const f = await dataFixture();
  await dataMeasurement(f.target, 1);
  let release;
  let entered;
  const blocked = new Promise((resolve) => {
    entered = resolve;
  });
  const wait = new Promise((resolve) => {
    release = resolve;
  });
  let first = true;
  const proxy = {
    query: pool.query.bind(pool),
    connect: async () => {
      const client = await pool.connect();
      return {
        release: client.release.bind(client),
        query: async (...args) => {
          const result = await client.query(...args);
          if (first && String(args[0]).startsWith("FETCH")) {
            first = false;
            entered();
            await wait;
          }
          return result;
        },
      };
    },
  };
  const data = new WorkspaceData(proxy, { batchRows: 1 });
  const http = await archiveServer(data, f.memberSession);
  try {
    const response = await fetch(http.url);
    const result = response.text().then(
      () => ({ failed: false }),
      () => ({ failed: true }),
    );
    await blocked;
    await pool.query("DELETE FROM sessions WHERE token_hash=$1", [
      f.memberSession.token_hash,
    ]);
    release();
    assert.equal((await result).failed, true);
    await http.done;
    assert.equal(data.exports.size, 0);
    assert.equal((await pool.query("SELECT 1 AS alive")).rows[0].alive, 1);
  } finally {
    release();
    await http.close();
  }
});

test("an oversized archive never returns a successful completion marker and releases the export slot", async () => {
  const f = await dataFixture();
  const data = new WorkspaceData(pool, { maxBytes: 16 });
  const http = await archiveServer(data, f.memberSession);
  try {
    await assert.rejects(async () => {
      const response = await fetch(http.url);
      await response.text();
    });
    await http.done;
    assert.equal(data.exports.size, 0);
  } finally {
    await http.close();
  }
});

test("retention removes bounded old readings while preserving the current sample and other workspaces", async () => {
  const f = await dataFixture();
  const old = await dataMeasurement(f.target, 400, 601);
  const newest = await dataMeasurement(f.target, 0, 1);
  const other = await dataMeasurement(ids.alpha, 400);
  await f.data.updateRetention(f.memberSession, retentionBody());
  const worker = new DataMaintenance(pool);
  const first = await worker.runOnce(f.target.tenant);
  assert.equal(first.measurements, 500);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM measurements WHERE tenant_id=$1",
        [f.target.tenant],
      )
    ).rows[0].n,
    102,
  );
  await pool.query(
    "UPDATE workspace_retention SET next_run_at=clock_timestamp() WHERE tenant_id=$1",
    [f.target.tenant],
  );
  assert.equal((await worker.runOnce(f.target.tenant)).measurements, 101);
  assert.deepEqual(
    (
      await pool.query("SELECT id::text FROM measurements WHERE tenant_id=$1", [
        f.target.tenant,
      ])
    ).rows.map((r) => r.id),
    newest,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM measurements WHERE id=ANY($1::bigint[])",
        [other],
      )
    ).rows[0].n,
    1,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM measurements WHERE id=ANY($1::bigint[])",
        [old],
      )
    ).rows[0].n,
    0,
  );
  const policy = await f.data.retention(f.target.tenant);
  assert.ok(policy.lastRunAt);
  assert.equal(policy.lastFailedAt, null);
});

test("retention preserves unresolved writes, their commands, active incidents and the rolling API ledger", async () => {
  const f = await dataFixture();
  await f.data.updateRetention(f.memberSession, retentionBody());
  const job = randomUUID(),
    write = randomUUID(),
    incident = randomUUID();
  await pool.query(
    "INSERT INTO command_executions(id,tenant_id,account_id,device,actor,action,status,created_at,completed_at) VALUES($1,$2,$3,$4,'fixture','topup','interrupted',now()-interval '400 days',now()-interval '400 days')",
    [job, f.target.tenant, f.target.account, f.target.device],
  );
  await pool.query(
    "INSERT INTO device_control_state(tenant_id,account_id,device,state) VALUES($1,$2,$3,'uncertain')",
    [f.target.tenant, f.target.account, f.target.device],
  );
  await pool.query(
    "INSERT INTO inverter_write_intents(id,tenant_id,account_id,device,execution_id,operation,address,register_values,status,created_at) VALUES($1,$2,$3,$4,$5,'enable',206,'[0,25]','uncertain',now()-interval '400 days')",
    [write, f.target.tenant, f.target.account, f.target.device, job],
  );
  await pool.query(
    "INSERT INTO operational_incidents(id,tenant_id,account_id,device,binding,kind,severity,first_seen_at,last_seen_at) VALUES($1,$2,$3,$4,'fixture','cleanup_pending','critical',now()-interval '400 days',now())",
    [incident, f.target.tenant, f.target.account, f.target.device],
  );
  for (const days of [364, 367])
    await pool.query(
      "INSERT INTO api_requests(tenant_id,account_id,kind,created_at) VALUES($1,$2,'read',clock_timestamp()-$3*interval '1 day')",
      [f.target.tenant, f.target.account, days],
    );
  const worker = new DataMaintenance(pool);
  const result = await worker.runOnce(f.target.tenant);
  assert.equal(result.writes, 0);
  assert.equal(result.commands, 0);
  assert.equal(result.incidents, 0);
  assert.equal(result.usage, 1);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM api_requests WHERE tenant_id=$1",
        [f.target.tenant],
      )
    ).rows[0].n,
    1,
  );
  // A clear lease alone does not turn an unknown write into a resolved write.
  await pool.query(
    "UPDATE device_control_state SET state='clear' WHERE tenant_id=$1",
    [f.target.tenant],
  );
  await pool.query(
    "UPDATE workspace_retention SET next_run_at=clock_timestamp() WHERE tenant_id=$1",
    [f.target.tenant],
  );
  assert.equal((await worker.runOnce(f.target.tenant)).writes, 0);
  await pool.query(
    "UPDATE inverter_write_intents SET reconciled_at=now()-interval '90 days' WHERE id=$1",
    [write],
  );
  await pool.query(
    "UPDATE operational_incidents SET resolved_at=now()-interval '90 days',resolution_reason='cleared' WHERE id=$1",
    [incident],
  );
  await pool.query(
    "UPDATE workspace_retention SET next_run_at=clock_timestamp() WHERE tenant_id=$1",
    [f.target.tenant],
  );
  const cleared = await worker.runOnce(f.target.tenant);
  assert.equal(cleared.writes, 1);
  assert.equal(cleared.commands, 1);
  assert.equal(cleared.incidents, 1);
});

test("a later pruning failure rolls back earlier deletions, records the failure and allows a retry", async () => {
  const f = await dataFixture();
  await dataMeasurement(f.target, 400, 2);
  await dataMeasurement(f.target, 0);
  await f.data.updateRetention(f.memberSession, retentionBody());
  const trigger = `retention_failure_${randomUUID().replaceAll("-", "")}`;
  await pool.query(
    `CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.tenant_id='${f.target.tenant}'::uuid THEN RAISE EXCEPTION 'fixture failure'; END IF; RETURN OLD; END $$`,
  );
  await pool.query(
    `CREATE TRIGGER ${trigger} BEFORE DELETE ON api_requests FOR EACH ROW EXECUTE FUNCTION ${trigger}()`,
  );
  await pool.query(
    "INSERT INTO api_requests(tenant_id,account_id,kind,created_at) VALUES($1,$2,'read',now()-interval '400 days')",
    [f.target.tenant, f.target.account],
  );
  const worker = new DataMaintenance(pool);
  try {
    await assert.rejects(worker.runOnce(f.target.tenant));
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM measurements WHERE tenant_id=$1",
          [f.target.tenant],
        )
      ).rows[0].n,
      3,
    );
    const policy = await f.data.retention(f.target.tenant);
    assert.ok(policy.lastFailedAt);
    assert.equal(policy.lastRunAt, null);
  } finally {
    await pool.query(`DROP TRIGGER ${trigger} ON api_requests`);
    await pool.query(`DROP FUNCTION ${trigger}()`);
  }
  await pool.query(
    "UPDATE workspace_retention SET next_run_at=clock_timestamp() WHERE tenant_id=$1",
    [f.target.tenant],
  );
  assert.equal((await worker.runOnce(f.target.tenant)).measurements, 2);
  assert.equal((await f.data.retention(f.target.tenant)).lastFailedAt, null);
});

test("a locked or disabled retention policy does not prune data and does not lock inverter control", async () => {
  const f = await dataFixture();
  await dataMeasurement(f.target, 400);
  await f.data.updateRetention(f.memberSession, retentionBody());
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT tenant_id FROM workspace_retention WHERE tenant_id=$1 FOR UPDATE",
      [f.target.tenant],
    );
    assert.equal(
      await new DataMaintenance(pool).runOnce(f.target.tenant),
      null,
    );
    await client.query("COMMIT");
    await f.data.updateRetention(
      f.memberSession,
      retentionBody({ enabled: false, revision: "1" }),
    );
    assert.equal(
      await new DataMaintenance(pool).runOnce(f.target.tenant),
      null,
    );
    await client.query("BEGIN");
    await client.query(
      "SELECT tenant_id FROM controller_state WHERE tenant_id=$1 FOR UPDATE",
      [f.target.tenant],
    );
    // Maintenance owns the retention-policy row, independently of the inverter-control row.
    await f.data.updateRetention(
      f.memberSession,
      retentionBody({ enabled: true, revision: "2" }),
    );
    assert.equal(
      (await new DataMaintenance(pool).runOnce(f.target.tenant)).measurements,
      0,
    );
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
});

test("retention prunes obsolete provider and security history while keeping current device data and active recovery access", async () => {
  const f = await dataFixture();
  await f.data.updateRetention(f.memberSession, retentionBody());
  const protectedDevice = `protected-${randomUUID()}`;
  for (const device of [
    f.target.device,
    `obsolete-${randomUUID()}`,
    protectedDevice,
  ])
    await pool.query(
      "INSERT INTO provider_readings(tenant_id,account_id,device,collected_at,received_at,data_list) VALUES($1,$2,$3,now()-interval '400 days',now()-interval '400 days','[]')",
      [f.target.tenant, f.target.account, device],
    );
  await pool.query(
    "INSERT INTO device_control_state(tenant_id,account_id,device,state) VALUES($1,$2,$3,'cleanup-required')",
    [f.target.tenant, f.target.account, protectedDevice],
  );
  await pool.query(
    "INSERT INTO account_security_events(tenant_id,user_id,kind,affected_sessions,occurred_at) VALUES($1,$2,'signed_in',1,now()-interval '400 days')",
    [f.target.tenant, f.target.user],
  );
  for (const [kind, used, expired] of [
    ["saved_key", true, false],
    ["admin_link", false, true],
    ["saved_key", false, false],
  ])
    await pool.query(
      `INSERT INTO account_recovery_tokens(user_id,token_hash,kind,created_at,used_at,expires_at) VALUES($1,$2,$3,now()-interval '400 days',CASE WHEN $4 THEN now()-interval '90 days' ELSE null END,CASE WHEN $5 THEN now()-interval '90 days' ELSE null END)`,
      [f.target.user, tokenHash(randomUUID()), kind, used, expired],
    );
  const counts = await new DataMaintenance(pool).runOnce(f.target.tenant);
  assert.equal(counts.providerReadings, 1);
  assert.equal(counts.security, 1);
  assert.equal(counts.recovery, 2);
  assert.deepEqual(
    (
      await pool.query(
        "SELECT device FROM provider_readings WHERE tenant_id=$1 ORDER BY device",
        [f.target.tenant],
      )
    ).rows.map((row) => row.device),
    [f.target.device, protectedDevice].sort(),
  );
  const keys = (
    await pool.query(
      "SELECT kind,used_at,expires_at FROM account_recovery_tokens WHERE user_id=$1",
      [f.target.user],
    )
  ).rows;
  assert.equal(keys.length, 1);
  assert.equal(keys[0].kind, "saved_key");
  assert.equal(keys[0].used_at, null);
});

test("concurrent retention changes accept only one displayed revision", async () => {
  const f = await dataFixture();
  const results = await Promise.allSettled([
    f.data.updateRetention(f.memberSession, retentionBody()),
    new WorkspaceData(pool).updateRetention(
      f.memberSession,
      retentionBody({ measurementDays: 180 }),
    ),
  ]);
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  const rejected = results.find((result) => result.status === "rejected");
  assert.equal(rejected.reason.status, 409);
  const policy = await f.data.retention(f.target.tenant);
  assert.equal(policy.revision, "1");
  assert.equal(policy.events.length, 1);
});

test("retention preserves request receipts so retrying a pruned command cannot execute it again", async () => {
  const f = await dataFixture();
  await f.data.updateRetention(f.memberSession, retentionBody());
  const job = randomUUID(),
    requestId = randomUUID();
  await pool.query(
    "INSERT INTO command_executions(id,tenant_id,user_id,actor,action,idempotency_key,status,created_at,completed_at) VALUES($1,$2,$3,'fixture','resume',$4,'succeeded',now()-interval '400 days',now()-interval '400 days')",
    [job, f.target.tenant, f.target.user, requestId],
  );
  assert.equal(
    (await new DataMaintenance(pool).runOnce(f.target.tenant)).commands,
    1,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM command_receipts WHERE tenant_id=$1 AND user_id=$2 AND idempotency_key=$3",
        [f.target.tenant, f.target.user, requestId],
      )
    ).rows[0].n,
    1,
  );
  const runtime = await hub.forTenant(f.target.tenant);
  await assert.rejects(
    runtime.submit(
      "resume",
      { id: f.target.user, tenant_id: f.target.tenant },
      requestId,
    ),
    /expired from history/,
  );
  await assert.rejects(
    runtime.submit(
      "pause",
      { id: f.target.user, tenant_id: f.target.tenant },
      requestId,
    ),
    /another action/,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM command_executions WHERE tenant_id=$1 AND idempotency_key=$2",
        [f.target.tenant, requestId],
      )
    ).rows[0].n,
    0,
  );
});

test("retention skips an account update before acquiring its policy lock instead of deadlocking receipt insertion", async () => {
  const f = await dataFixture();
  await f.data.updateRetention(f.memberSession, retentionBody());
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [
      f.target.user,
    ]);
    assert.equal(
      await new DataMaintenance(pool).runOnce(f.target.tenant),
      null,
    );
    assert.equal((await f.data.retention(f.target.tenant)).lastFailedAt, null);
    await client.query("COMMIT");
    assert.ok(await new DataMaintenance(pool).runOnce(f.target.tenant));
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
});

test("the archive byte limit includes its completion marker", async () => {
  const f = await dataFixture();
  const data = new WorkspaceData(pool);
  const http = await archiveServer(data, f.memberSession);
  try {
    const complete = await (await fetch(http.url)).text();
    data.maxBytes = Buffer.byteLength(complete) - 1;
    await assert.rejects(async () => {
      const response = await fetch(http.url);
      await response.text();
    });
    assert.equal(data.exports.size, 0);
  } finally {
    await http.close();
  }
});

async function erasureFixture() {
  const f = await lifecycleFixture();
  const directory = await mkdtemp(path.join(tmpdir(), "solarman-offboarding-"));
  const guardFile = path.join(directory, "guard.json");
  const previousFile = hub.offboarding.guardFile;
  const previousRoot = hub.offboarding.requireRoot;
  hub.offboarding.guardFile = guardFile;
  hub.offboarding.requireRoot = false;
  const records = [];
  const guard = async (patch = {}) =>
    writeFile(
      guardFile,
      JSON.stringify({
        version: 1,
        state: "verified",
        checkedAt: new Date().toISOString(),
        records,
        ...patch,
      }),
      { mode: 0o600 },
    );
  await guard();
  const route = `/admin/tenants/${f.target.tenant}/offboarding`;
  const body = async (action, patch = {}) => ({
    action,
    currentPassword: password,
    confirmation: "Lifecycle member",
    eraseConfirmed: action === "erase",
    revision: (
      await pool.query(
        "SELECT lifecycle_revision::text AS revision FROM tenants WHERE id=$1",
        [f.target.tenant],
      )
    ).rows[0].revision,
    ...patch,
  });
  const change = async (action, patch = {}) =>
    fetchApi(route, {
      auth: f.admin,
      method: "POST",
      body: await body(action, patch),
    });
  const publish = async () => {
    const row = (
      await pool.query(
        "SELECT id,erasure_authorized_at FROM workspace_offboarding WHERE tenant_id=$1",
        [f.target.tenant],
      )
    ).rows[0];
    const record = {
      version: 1,
      id: row.id,
      tenantId: f.target.tenant,
      authorizedAt: row.erasure_authorized_at.toISOString(),
    };
    records.splice(0, records.length, record);
    await guard();
    await pool.query(
      "UPDATE workspace_offboarding SET offsite_acknowledged_at=clock_timestamp() WHERE tenant_id=$1",
      [f.target.tenant],
    );
    return record;
  };
  const status = () => hub.offboarding.status(f.target.tenant);
  const dispose = async () => {
    const runtime = hub.runtimes.get(f.target.tenant);
    if (runtime) {
      await runtime.close();
      hub.runtimes.delete(f.target.tenant);
    }
    await pool.query(
      "UPDATE workspace_offboarding SET last_attempted_at='9999-01-01' WHERE tenant_id=$1",
      [f.target.tenant],
    );
    hub.offboarding.guardFile = previousFile;
    hub.offboarding.requireRoot = previousRoot;
    await rm(directory, { recursive: true, force: true });
  };
  return {
    ...f,
    directory,
    guardFile,
    records,
    guard,
    route,
    body,
    change,
    publish,
    status,
    dispose,
    closure: hub.offboarding,
    address: `lifecycle-member-${f.target.user}@example.test`,
  };
}

async function readyForErasure(f) {
  assert.equal((await f.change("close")).status, 200);
  assert.equal((await f.change("erase")).status, 200);
  return f.publish();
}

test("workspace erasure requires administrator proof, exact confirmation, current revision and explicit consent", async () => {
  const f = await erasureFixture();
  try {
    for (const [options, expected] of [
      [{ auth: f.member, body: await f.body("close") }, 403],
      [{ auth: f.admin, csrf: false, body: await f.body("close") }, 403],
      [
        {
          auth: f.admin,
          body: await f.body("close", { currentPassword: "wrong" }),
        },
        400,
      ],
      [
        {
          auth: f.admin,
          body: await f.body("close", { confirmation: "different workspace" }),
        },
        400,
      ],
      [
        { auth: f.admin, body: await f.body("close", { revision: "100" }) },
        409,
      ],
    ])
      assert.equal(
        (await fetchApi(f.route, { method: "POST", ...options })).status,
        expected,
      );
    assert.equal(
      (
        await fetchApi(`/admin/tenants/${f.actor.tenant}/offboarding`, {
          auth: f.admin,
          method: "POST",
          body: await f.body("close", {
            confirmation: "Lifecycle administrator",
          }),
        })
      ).status,
      409,
    );
    assert.equal((await f.status()).phase, "none");
    assert.equal((await f.change("close")).status, 200);
    assert.equal(
      (await f.change("erase", { eraseConfirmed: false })).status,
      409,
    );
    await f.guard({ checkedAt: new Date(Date.now() - 301000).toISOString() });
    assert.equal((await f.change("erase")).status, 409);
    assert.equal((await f.status()).authorizedAt, null);
  } finally {
    await f.dispose();
  }
});

test("workspace erasure closure revokes sessions, stops collection and cancels into suspension without rearming", async () => {
  const f = await erasureFixture();
  try {
    await pool.query(
      "INSERT INTO workspace_retention(tenant_id,enabled) VALUES($1,true)",
      [f.target.tenant],
    );
    assert.equal((await f.change("close")).status, 200);
    assert.equal(
      (await fetchApi("/auth/session", { auth: f.member })).status,
      401,
    );
    const member = await login(f.address);
    assert.equal(
      (await fetchApi("/workspace/offboarding", { auth: member })).status,
      200,
    );
    const runtime = await hub.forTenant(f.target.tenant);
    assert.equal(runtime.lifecycle, "offboarding");
    assert.equal(runtime.status().control.canStart, false);
    assert.equal(runtime.status().mode, "offboarding");
    assert.equal(
      (
        await pool.query(
          "SELECT enabled FROM workspace_retention WHERE tenant_id=$1",
          [f.target.tenant],
        )
      ).rows[0].enabled,
      false,
    );
    assert.equal((await f.change("cancel")).status, 200);
    const state = (
      await pool.query(
        "SELECT t.lifecycle,c.paused,c.control_enabled FROM tenants t JOIN controller_state c ON c.tenant_id=t.id WHERE t.id=$1",
        [f.target.tenant],
      )
    ).rows[0];
    assert.deepEqual(state, {
      lifecycle: "suspended",
      paused: true,
      control_enabled: false,
    });
    assert.equal((await f.status()).phase, "none");
    assert.equal((await f.change("close")).status, 200);
  } finally {
    await f.dispose();
  }
});

test("workspace erasure cannot discard unknown inverter writes or running commands", async () => {
  const f = await erasureFixture();
  try {
    assert.equal((await f.change("close")).status, 200);
    await pool.query(
      "INSERT INTO device_control_state(tenant_id,account_id,device,state) VALUES($1,$2,$3,'uncertain')",
      [f.target.tenant, f.target.account, f.target.device],
    );
    const intent = randomUUID();
    await pool.query(
      "INSERT INTO inverter_write_intents(id,tenant_id,account_id,device,operation,address,register_values,status) VALUES($1,$2,$3,$4,'enable',206,'[0,25]','uncertain')",
      [intent, f.target.tenant, f.target.account, f.target.device],
    );
    assert.equal((await f.change("erase")).status, 409);
    assert.equal((await f.status()).phase, "cleanup");
    await pool.query(
      "UPDATE device_control_state SET state='clear' WHERE tenant_id=$1",
      [f.target.tenant],
    );
    assert.equal((await f.change("erase")).status, 409);
    await pool.query(
      "UPDATE inverter_write_intents SET reconciled_at=clock_timestamp() WHERE id=$1",
      [intent],
    );
    const job = randomUUID();
    await pool.query(
      "INSERT INTO command_executions(id,tenant_id,actor,action,status) VALUES($1,$2,'fixture','refresh','running')",
      [job, f.target.tenant],
    );
    assert.equal((await f.change("erase")).status, 409);
    await pool.query(
      "UPDATE command_executions SET status='succeeded' WHERE id=$1",
      [job],
    );
    assert.equal((await f.change("erase")).status, 200);
    assert.equal((await f.change("cancel")).status, 409);
    assert.equal((await f.status()).phase, "awaiting-receipt");
    assert.equal(
      (
        await pool.query(
          "SELECT credentials IS NOT NULL AS retained FROM solarman_accounts WHERE tenant_id=$1",
          [f.target.tenant],
        )
      ).rows[0].retained,
      true,
    );
  } finally {
    await f.dispose();
  }
});

test("workspace erasure authorization prevents legacy sessions, recovery, routine requests and reactivation", async () => {
  const f = await erasureFixture();
  try {
    assert.equal((await f.change("close")).status, 200);
    const member = await login(f.address);
    assert.equal((await f.change("erase")).status, 200);
    assert.equal(
      (await fetchApi("/auth/session", { auth: member })).status,
      401,
    );
    assert.equal(
      (
        await fetchApi("/auth/login", {
          method: "POST",
          body: { email: f.address, password },
        })
      ).status,
      401,
    );
    const statements = [
      [
        "INSERT INTO sessions(user_id,token_hash,csrf_token,expires_at) VALUES($1,$2,'fixture',now()+interval '1 day')",
        [f.target.user, tokenHash(randomUUID())],
      ],
      [
        "INSERT INTO account_recovery_tokens(user_id,token_hash,kind) VALUES($1,$2,'saved_key')",
        [f.target.user, tokenHash(randomUUID())],
      ],
      [
        "INSERT INTO api_requests(tenant_id,account_id,kind,purpose) VALUES($1,$2,'read','routine')",
        [f.target.tenant, f.target.account],
      ],
      ["UPDATE tenants SET lifecycle='active' WHERE id=$1", [f.target.tenant]],
      [
        "UPDATE controller_state SET control_enabled=true WHERE tenant_id=$1",
        [f.target.tenant],
      ],
      [
        "UPDATE controller_state SET paused=false WHERE tenant_id=$1",
        [f.target.tenant],
      ],
    ];
    for (const [sql, values] of statements)
      await assert.rejects(pool.query(sql, values), { code: "23514" });
    await pool.query(
      "INSERT INTO api_requests(tenant_id,account_id,kind,purpose) VALUES($1,$2,'read','recovery')",
      [f.target.tenant, f.target.account],
    );
    await pool.query(
      "INSERT INTO api_requests(tenant_id,account_id,kind,purpose) VALUES($1,$2,'read','balance')",
      [f.target.tenant, f.target.account],
    );
  } finally {
    await f.dispose();
  }
});

test("workspace erasure guards serialize a delayed legacy login against authorization", async () => {
  const f = await erasureFixture();
  const connection = await pool.connect();
  let pending;
  try {
    assert.equal((await f.change("close")).status, 200);
    await connection.query("BEGIN");
    await connection.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [
      f.target.user,
    ]);
    pending = Promise.allSettled([
      pool.query(
        "/* erasure legacy session */ INSERT INTO sessions(user_id,token_hash,csrf_token,expires_at) VALUES($1,$2,'fixture',now()+interval '1 day')",
        [f.target.user, tokenHash(randomUUID())],
      ),
    ]);
    let waiting = false;
    for (let i = 0; i < 100; i++) {
      const observed = await pool.query(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '/* erasure legacy session */%'",
      );
      if (observed.rows[0].n > 0) {
        waiting = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(waiting, true);
    await connection.query(
      "UPDATE workspace_offboarding SET erasure_authorized_at=date_trunc('milliseconds',clock_timestamp()) WHERE tenant_id=$1",
      [f.target.tenant],
    );
    await connection.query("COMMIT");
    const result = (await pending)[0];
    assert.equal(result.status, "rejected");
    assert.equal(result.reason.code, "23514");
  } finally {
    await connection.query("ROLLBACK");
    connection.release();
    if (pending) await pending;
    await f.dispose();
  }
});

test("workspace erasure needs both matching local and offsite acknowledgment at the final removal boundary", async () => {
  const f = await erasureFixture();
  try {
    assert.equal((await f.change("close")).status, 200);
    assert.equal((await f.change("erase")).status, 200);
    assert.equal(await f.closure.purge(f.target.tenant), false);
    await f.publish();
    await f.guard({ checkedAt: new Date(Date.now() - 301000).toISOString() });
    await assert.rejects(f.closure.purge(f.target.tenant), /unavailable/);
    await f.guard({ records: [{ ...f.records[0], id: randomUUID() }] });
    assert.equal(await f.closure.purge(f.target.tenant), false);
    assert.equal(
      (
        await pool.query(
          "SELECT credentials IS NOT NULL AS retained FROM solarman_accounts WHERE tenant_id=$1",
          [f.target.tenant],
        )
      ).rows[0].retained,
      true,
    );
    await f.guard();
    assert.equal(await f.closure.runOnce(), true);
    assert.equal((await f.status()).phase, "removed");
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM users WHERE tenant_id=$1",
          [f.target.tenant],
        )
      ).rows[0].n,
      0,
    );
    assert.equal(
      (await fetchApi("/auth/session", { auth: alpha })).status,
      200,
    );
  } finally {
    await f.dispose();
  }
});

test("workspace erasure removes credentials in the first bounded batch and preserves anonymous shared quota accounting", async () => {
  const f = await erasureFixture();
  const appKey = apiAppKey(`lifecycle-${f.target.tenant}`);
  try {
    await pool.query(
      "INSERT INTO api_app_budgets(app_key) VALUES($1) ON CONFLICT DO NOTHING",
      [appKey],
    );
    await pool.query(
      "UPDATE solarman_accounts SET api_app_key=$2 WHERE tenant_id=$1",
      [f.target.tenant, appKey],
    );
    await pool.query(
      `INSERT INTO measurements(tenant_id,account_id,device,observed_at,soc,temperature_c,pv_w,load_w,grid_w,battery_w,ac_enabled,snapshot)
      SELECT $1,$2,$3,now()-n*interval '1 second',60,20,3000,1000,0,-2000,false,'{}' FROM generate_series(1,1201)n`,
      [f.target.tenant, f.target.account, f.target.device],
    );
    await pool.query(
      "INSERT INTO api_requests(tenant_id,account_id,kind,app_key,purpose) SELECT $1,$2,'read',$3,'routine' FROM generate_series(1,501)",
      [f.target.tenant, f.target.account, appKey],
    );
    const invitation = randomUUID(),
      replacement = randomUUID();
    await pool.query(
      "INSERT INTO invitations(id,token_hash,email,tenant_name,created_by,expires_at,used_at) VALUES($1,$2,$3,'fixture',$4,now(),now()),($5,$6,$3,'fixture',$4,now(),now())",
      [
        invitation,
        tokenHash(randomUUID()),
        f.address,
        f.actor.user,
        replacement,
        tokenHash(randomUUID()),
      ],
    );
    await pool.query("UPDATE invitations SET replaced_by_id=$2 WHERE id=$1", [
      invitation,
      replacement,
    ]);
    await readyForErasure(f);
    assert.equal(await f.closure.runOnce(), true);
    const account = (
      await pool.query(
        "SELECT credentials,email FROM solarman_accounts WHERE tenant_id=$1",
        [f.target.tenant],
      )
    ).rows[0];
    assert.deepEqual(account, { credentials: null, email: "" });
    assert.equal((await f.status()).phase, "erasing");
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM measurements WHERE tenant_id=$1",
          [f.target.tenant],
        )
      ).rows[0].n,
      701,
    );
    assert.equal((await verifyStoredCredentials(pool, key)) >= 2, true);
    await assert.rejects(
      pool.query(
        "INSERT INTO api_requests(tenant_id,account_id,kind,purpose) VALUES($1,$2,'read','recovery')",
        [f.target.tenant, f.target.account],
      ),
      { code: "23514" },
    );
    const restarted = new WorkspaceOffboarding(pool, hub, {
      guardFile: f.guardFile,
      requireRoot: false,
    });
    for (let i = 0; i < 8 && (await f.status()).phase !== "removed"; i++)
      await restarted.runOnce();
    assert.equal((await f.status()).phase, "removed");
    const ledger = (
      await pool.query(
        "SELECT count(*)::int AS n,count(*) FILTER(WHERE tenant_id IS NULL AND account_id IS NULL)::int AS anonymous FROM api_requests WHERE app_key=$1",
        [appKey],
      )
    ).rows[0];
    assert.deepEqual(ledger, { n: 501, anonymous: 501 });
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM invitations WHERE id=ANY($1::uuid[])",
          [[invitation, replacement]],
        )
      ).rows[0].n,
      0,
    );
    const tombstone = (
      await pool.query(
        "SELECT t.name,t.lifecycle,o.requested_by,o.completed_at FROM tenants t JOIN workspace_offboarding o ON o.tenant_id=t.id WHERE t.id=$1",
        [f.target.tenant],
      )
    ).rows[0];
    assert.equal(tombstone.name, "Removed workspace");
    assert.equal(tombstone.requested_by, null);
    assert.ok(tombstone.completed_at);
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM measurements WHERE tenant_id=$1",
          [ids.beta.tenant],
        )
      ).rows[0].n > 0,
      true,
    );
  } finally {
    await f.dispose();
  }
});

test("workspace erasure releases polling and resumes monitoring after cancellation", async () => {
  const f = await erasureFixture();
  const { runtime, calls } = await controlFixture(false, f.target);
  hub.runtimes.set(f.target.tenant, runtime);
  try {
    runtime.start();
    await runtime.work.idle();
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(runtime.timer);
    assert.equal((await f.change("close")).status, 200);
    assert.equal(runtime.timer, null);
    assert.equal(runtime.nextPollAt, null);
    const before = calls.length;
    await runtime.collect();
    assert.equal(calls.length, before);
    assert.equal((await f.change("cancel")).status, 200);
    assert.equal(runtime.lifecycle, "suspended");
    assert.ok(runtime.timer);
    assert.equal(runtime.controlEnabled, false);
    assert.equal(runtime.paused, true);
  } finally {
    await f.dispose();
  }
});

test("workspace erasure rollback preserves credentials, records and retry obligations", async () => {
  const f = await erasureFixture();
  const name = "erasure_fixture_" + randomUUID().replaceAll("-", "");
  try {
    await pool.query(
      "INSERT INTO measurements(tenant_id,account_id,device,observed_at,soc,temperature_c,pv_w,load_w,grid_w,battery_w,ac_enabled,snapshot) VALUES($1,$2,$3,now(),60,20,1000,500,0,-500,false,'{}')",
      [f.target.tenant, f.target.account, f.target.device],
    );
    await readyForErasure(f);
    await pool.query(
      `CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.tenant_id='${f.target.tenant}'::uuid THEN RAISE EXCEPTION 'fixture_delete_failure'; END IF; RETURN OLD; END $$`,
    );
    await pool.query(
      `CREATE TRIGGER ${name} BEFORE DELETE ON measurements FOR EACH ROW EXECUTE FUNCTION ${name}()`,
    );
    await assert.rejects(f.closure.runOnce(), /fixture_delete_failure/);
    const account = (
      await pool.query(
        "SELECT credentials IS NOT NULL AS retained FROM solarman_accounts WHERE tenant_id=$1",
        [f.target.tenant],
      )
    ).rows[0];
    assert.equal(account.retained, true);
    const status = await f.status();
    assert.equal(status.startedAt, null);
    assert.ok(status.lastFailedAt);
    assert.equal(hub.erasingTenants.has(f.target.tenant), false);
    assert.equal(hub.accountUpdates.has(f.target.tenant), false);
    await pool.query(`DROP TRIGGER ${name} ON measurements`);
    await pool.query(`DROP FUNCTION ${name}()`);
    assert.equal(await f.closure.runOnce(), true);
    assert.equal((await f.status()).phase, "removed");
  } finally {
    await pool.query(`DROP TRIGGER IF EXISTS ${name} ON measurements`);
    await pool.query(`DROP FUNCTION IF EXISTS ${name}()`);
    await f.dispose();
  }
});

test("workspace erasure drains concurrent runtime loading before removing credentials", async () => {
  const f = await erasureFixture();
  const original = TenantRuntime.prototype.initialize;
  let entered;
  const waiting = new Promise((resolve) => {
    entered = resolve;
  });
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let loaded, worker;
  try {
    await readyForErasure(f);
    TenantRuntime.prototype.initialize = async function () {
      if (this.tenantId === f.target.tenant) {
        entered();
        await gate;
      }
      return original.call(this);
    };
    loaded = Promise.allSettled([hub.forTenant(f.target.tenant)]);
    await waiting;
    worker = f.closure.runOnce();
    for (let i = 0; i < 100 && !hub.erasingTenants.has(f.target.tenant); i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(hub.erasingTenants.has(f.target.tenant), true);
    assert.equal(
      (
        await pool.query(
          "SELECT credentials IS NOT NULL AS retained FROM solarman_accounts WHERE tenant_id=$1",
          [f.target.tenant],
        )
      ).rows[0].retained,
      true,
    );
    release();
    const result = (await loaded)[0];
    assert.equal(result.status, "rejected");
    assert.equal(result.reason.status, 409);
    assert.equal(await worker, true);
    assert.equal((await f.status()).phase, "removed");
    assert.equal(hub.runtimes.has(f.target.tenant), false);
    assert.equal(hub.erasingTenants.has(f.target.tenant), false);
  } finally {
    release();
    if (loaded) await loaded;
    if (worker) await worker.catch(() => {});
    TenantRuntime.prototype.initialize = original;
    await f.dispose();
  }
});

test("workspace erasure retains recovery when a closing runtime reveals a late cleanup obligation", async () => {
  const f = await erasureFixture();
  try {
    await readyForErasure(f);
    const late = {
      close: async () => {
        await pool.query(
          "INSERT INTO device_control_state(tenant_id,account_id,device,state) VALUES($1,$2,$3,'uncertain')",
          [f.target.tenant, f.target.account, f.target.device],
        );
      },
    };
    hub.runtimes.set(f.target.tenant, late);
    assert.equal(await f.closure.runOnce(), false);
    const restored = hub.runtimes.get(f.target.tenant);
    assert.ok(restored);
    assert.notEqual(restored, late);
    assert.equal(restored.journal.pending, true);
    assert.equal((await f.status()).phase, "cleanup");
    assert.equal(
      (
        await pool.query(
          "SELECT credentials IS NOT NULL AS retained FROM solarman_accounts WHERE tenant_id=$1",
          [f.target.tenant],
        )
      ).rows[0].retained,
      true,
    );
    await pool.query(
      "UPDATE device_control_state SET state='clear' WHERE tenant_id=$1",
      [f.target.tenant],
    );
    await restored.journal.load();
    assert.equal(await f.closure.runOnce(), true);
    assert.equal((await f.status()).phase, "removed");
  } finally {
    await f.dispose();
  }
});

test("workspace erasure replays offsite fences before customer access and rejects administrator or conflicting fences", async () => {
  const f = await erasureFixture();
  const record = {
    version: 1,
    id: randomUUID(),
    tenantId: f.target.tenant,
    authorizedAt: new Date().toISOString(),
  };
  const recovery = tokenHash(randomUUID());
  try {
    await pool.query(
      "UPDATE controller_state SET paused=false,control_enabled=true,manual_topup=true WHERE tenant_id=$1",
      [f.target.tenant],
    );
    await pool.query(
      "INSERT INTO account_recovery_tokens(user_id,token_hash,kind) VALUES($1,$2,'saved_key')",
      [f.target.user, recovery],
    );
    await f.guard({ records: [record] });
    const restored = new WorkspaceOffboarding(
      pool,
      {},
      { guardFile: f.guardFile, requireRoot: false },
    );
    await restored.initialize();
    const state = (
      await pool.query(
        "SELECT t.lifecycle,c.paused,c.control_enabled,c.manual_topup,c.control_epoch FROM tenants t JOIN controller_state c ON c.tenant_id=t.id WHERE t.id=$1",
        [f.target.tenant],
      )
    ).rows[0];
    assert.equal(state.lifecycle, "offboarding");
    assert.equal(state.paused, true);
    assert.equal(state.control_enabled, false);
    assert.equal(state.manual_topup, false);
    assert.equal(
      (await fetchApi("/auth/session", { auth: f.member })).status,
      401,
    );
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM account_recovery_tokens WHERE user_id=$1 AND revoked_at IS NULL",
          [f.target.user],
        )
      ).rows[0].n,
      0,
    );
    assert.equal(
      (
        await fetchApi("/auth/login", {
          method: "POST",
          body: { email: f.address, password },
        })
      ).status,
      401,
    );
    await restored.replay([record]);
    assert.equal(
      (
        await pool.query(
          "SELECT control_epoch FROM controller_state WHERE tenant_id=$1",
          [f.target.tenant],
        )
      ).rows[0].control_epoch,
      state.control_epoch,
    );
    await assert.rejects(
      restored.replay([
        { ...record, authorizedAt: new Date(Date.now() + 1000).toISOString() },
      ]),
      /conflict/,
    );
    await assert.rejects(
      restored.replay([
        { ...record, id: randomUUID(), tenantId: f.actor.tenant },
      ]),
      /conflict/,
    );
    assert.equal(
      (await fetchApi("/auth/session", { auth: f.admin })).status,
      200,
    );
  } finally {
    await f.dispose();
  }
});

test("workspace erasure blocked by cleanup does not starve another ready tenant", async () => {
  const f = await erasureFixture();
  const other = await lifecycleFixture();
  try {
    await readyForErasure(f);
    await pool.query(
      "INSERT INTO device_control_state(tenant_id,account_id,device,state) VALUES($1,$2,$3,'uncertain')",
      [f.target.tenant, f.target.account, f.target.device],
    );
    const request = async (action) => {
      const revision = (
        await pool.query(
          "SELECT lifecycle_revision::text AS revision FROM tenants WHERE id=$1",
          [other.target.tenant],
        )
      ).rows[0].revision;
      return f.closure.request(other.session, other.target.tenant, {
        action,
        revision,
        currentPassword: password,
        confirmation: "Lifecycle member",
        eraseConfirmed: action === "erase",
      });
    };
    await request("close");
    await request("erase");
    const row = (
      await pool.query(
        "SELECT id,erasure_authorized_at FROM workspace_offboarding WHERE tenant_id=$1",
        [other.target.tenant],
      )
    ).rows[0];
    f.records.push({
      version: 1,
      id: row.id,
      tenantId: other.target.tenant,
      authorizedAt: row.erasure_authorized_at.toISOString(),
    });
    await f.guard();
    await pool.query(
      "UPDATE workspace_offboarding SET offsite_acknowledged_at=clock_timestamp() WHERE tenant_id=$1",
      [other.target.tenant],
    );
    assert.equal(await f.closure.runOnce(), false);
    assert.equal(await f.closure.runOnce(), true);
    assert.equal(
      (await f.closure.status(other.target.tenant)).phase,
      "removed",
    );
    assert.equal((await f.status()).phase, "cleanup");
  } finally {
    await f.dispose();
  }
});

test("workspace erasure health is private to administrators and reports a stale or missing fence service", async () => {
  const f = await erasureFixture();
  try {
    const normal = await (
      await fetchApi("/operations", { auth: f.member })
    ).json();
    assert.equal(Object.hasOwn(normal, "erasure"), false);
    const healthy = await (
      await fetchApi("/operations", { auth: f.admin })
    ).json();
    assert.equal(healthy.erasure.state, "verified");
    assert.equal(healthy.erasure.receipts, 0);
    await f.guard({ checkedAt: new Date(Date.now() - 301000).toISOString() });
    assert.equal(
      (await (await fetchApi("/operations", { auth: f.admin })).json()).erasure
        .state,
      "stale",
    );
    await rm(f.guardFile);
    assert.equal(
      (await (await fetchApi("/operations", { auth: f.admin })).json()).erasure
        .state,
      "unavailable",
    );
  } finally {
    await f.dispose();
  }
});

test("workspace erasure administrator recovery is restricted to the original inverter and preserves paused intent", async () => {
  const f = await erasureFixture();
  let runtime;
  try {
    await readyForErasure(f);
    const account = (
      await pool.query("SELECT * FROM solarman_accounts WHERE tenant_id=$1", [
        f.target.tenant,
      ])
    ).rows[0];
    const runtimeHub = {
      pool,
      key,
      stopping: false,
      env: {
        CALLBACK_PUBLIC_URL: "https://fixture.example.test",
        WRITES_ENABLED: "false",
      },
      budget: new ApiBudget(pool, {}),
      runLimited: async (fn) => fn(),
      monitorPollMs: () => 300000,
    };
    runtime = new TenantRuntime(runtimeHub, f.target.tenant, account);
    await runtime.initialize();
    await pool.query(
      "INSERT INTO device_control_state(tenant_id,account_id,device,state) VALUES($1,$2,$3,'uncertain') ON CONFLICT(tenant_id,account_id,device) DO UPDATE SET state='uncertain'",
      [f.target.tenant, f.target.account, f.target.device],
    );
    await runtime.journal.load();
    const commands = [];
    runtime.client.command = async (command, options) => {
      commands.push({ command, purpose: options.purpose });
      return "010304000000093A35";
    };
    runtime.client.api = async (route, body, options) => {
      assert.equal(route, "/device/v1.0/currentData");
      assert.equal(options.purpose, "recovery");
      return providerPayload({ device: runtime.device });
    };
    const scoped = Object.create(hub);
    scoped.accountUpdates = new Set();
    scoped.runtimes = new Map([[f.target.tenant, runtime]]);
    scoped.forTenant = async (tenant) => {
      assert.equal(tenant, f.target.tenant);
      return runtime;
    };
    scoped.reload = async () => runtime;
    let discovered = false;
    scoped.discover = async (tenant) => {
      assert.equal(tenant, f.target.tenant);
      discovered = true;
    };
    const recovery = new WorkspaceOffboarding(pool, scoped, {
      guardFile: f.guardFile,
      requireRoot: false,
    });
    await assert.rejects(
      recovery.recover(f.session, f.target.tenant, {
        action: "enable_controls",
        currentPassword: password,
      }),
      { status: 400 },
    );
    await recovery.recover(f.session, f.target.tenant, {
      action: "stop",
      currentPassword: password,
    });
    assert.equal(commands.length, 0);
    assert.equal((await f.status()).cleanupPending, true);
    await recovery.recover(f.session, f.target.tenant, {
      action: "inspect",
      currentPassword: password,
    });
    assert.equal(commands.length, 1);
    assert.equal(commands[0].purpose, "recovery");
    assert.equal(commands[0].command.slice(0, 4), "0103");
    assert.equal((await f.status()).cleanupPending, false);
    await runtime.readProvider();
    await assert.rejects(
      recovery.recover(f.session, f.target.tenant, {
        action: "repair",
        currentPassword: password,
        email: "different@example.test",
        password: "fixture-password",
      }),
      /already has a provider account/,
    );
    const replacement = "new-provider-fixture-password";
    await recovery.recover(f.session, f.target.tenant, {
      action: "repair",
      currentPassword: password,
      email: f.address,
      password: replacement,
      appId: "repaired-fixture-app",
      appSecret: "repaired-fixture-secret",
    });
    assert.equal(discovered, true);
    const updated = (
      await pool.query(
        "SELECT id,credentials,device_sn,profile FROM solarman_accounts WHERE tenant_id=$1",
        [f.target.tenant],
      )
    ).rows[0];
    const privateValues = decryptCredentials(
      updated.credentials,
      key,
      f.target.tenant,
      updated.id,
    );
    assert.equal(
      privateValues.passwordSha256,
      createHash("sha256").update(replacement).digest("hex"),
    );
    assert.equal(privateValues.appId, "repaired-fixture-app");
    assert.equal(updated.device_sn, f.target.device);
    assert.equal(updated.profile, "bluesun-bse20kh3");
    const control = (
      await pool.query(
        "SELECT paused,control_enabled,verification FROM controller_state WHERE tenant_id=$1",
        [f.target.tenant],
      )
    ).rows[0];
    assert.deepEqual(control, {
      paused: true,
      control_enabled: false,
      verification: null,
    });
  } finally {
    await runtime?.close();
    await f.dispose();
  }
});

test("workspace erasure credential checks reject missing secrets before erasure has started", async () => {
  const f = await erasureFixture();
  let original;
  try {
    original = (
      await pool.query(
        "SELECT credentials FROM solarman_accounts WHERE tenant_id=$1",
        [f.target.tenant],
      )
    ).rows[0].credentials;
    await pool.query(
      "UPDATE solarman_accounts SET credentials=null WHERE tenant_id=$1",
      [f.target.tenant],
    );
    await assert.rejects(
      verifyStoredCredentials(pool, key),
      /Missing credentials outside authorized erasure/,
    );
  } finally {
    if (original)
      await pool.query(
        "UPDATE solarman_accounts SET credentials=$2 WHERE tenant_id=$1",
        [f.target.tenant, original],
      );
    await f.dispose();
  }
});

test("workspace erasure anonymous quota accounting retains 366 days without a tenant retention policy", async () => {
  const appKey = apiAppKey(`anonymous-erasure-${randomUUID()}`);
  await pool.query("INSERT INTO api_app_budgets(app_key) VALUES($1)", [appKey]);
  const old = (
    await pool.query(
      "INSERT INTO api_requests(tenant_id,account_id,app_key,kind,purpose,created_at) VALUES(null,null,$1,'read','routine',clock_timestamp()-interval '367 days') RETURNING id",
      [appKey],
    )
  ).rows[0].id;
  const recent = (
    await pool.query(
      "INSERT INTO api_requests(tenant_id,account_id,app_key,kind,purpose,created_at) VALUES(null,null,$1,'command','recovery',clock_timestamp()-interval '365 days') RETURNING id",
      [appKey],
    )
  ).rows[0].id;
  const linked = (
    await pool.query(
      "INSERT INTO api_requests(tenant_id,account_id,app_key,kind,purpose,created_at) VALUES($1,$2,$3,'read','routine',clock_timestamp()-interval '367 days') RETURNING id",
      [ids.beta.tenant, ids.beta.account, appKey],
    )
  ).rows[0].id;
  await new DataMaintenance(pool).prune();
  const remaining = (
    await pool.query(
      "SELECT id,tenant_id,account_id,app_key,kind,purpose FROM api_requests WHERE id=ANY($1::bigint[]) ORDER BY id",
      [[old, recent, linked]],
    )
  ).rows;
  assert.deepEqual(
    remaining.map((row) => row.id),
    [recent, linked],
  );
  assert.deepEqual(remaining[0], {
    id: recent,
    tenant_id: null,
    account_id: null,
    app_key: appKey,
    kind: "command",
    purpose: "recovery",
  });
});
