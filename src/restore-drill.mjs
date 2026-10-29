import { randomBytes, randomUUID, createHash, createECDH } from "node:crypto";
import webpush from "web-push";
import { encryptPushSubscription, pushEndpointHash } from "./web-push.mjs";
import { createServer } from "node:http";
import assert from "node:assert/strict";
import { createPool, migrate } from "./database.mjs";
import { createApp } from "./http-app.mjs";
import { WorkspaceOffboarding } from "./workspace-offboarding.mjs";
import { erasureReceipt } from "./erasure-guard.mjs";
import { invalidateCommissioning } from "./commissioning-state.mjs";
import { Notifications } from "./notifications.mjs";
import {
  encryptNotificationSecret,
  verifyStoredNotificationSecrets,
} from "./notification-secrets.mjs";
import { quarantineNotifications } from "./notification-lifecycle.mjs";
import { hashPassword, validPasswordHash } from "./auth.mjs";
import {
  verifyStoredCredentials,
  encryptionKey,
  encryptCredentials,
} from "./credentials.mjs";
import {
  observationIdentity,
  observationBinding,
  emptyObservationProgress,
  quarantineObservationRuns,
} from "./policy-observations.mjs";
import {
  BackupError,
  identifier,
  inventory,
  runBuffered,
  UUID,
} from "./backup-io.mjs";

/** @param {import('pg').Pool} pool @param {import('./erasure-guard.mjs').ErasureReceipt[]} records @returns {Promise<{receipts:number,restoredTargets:number}>} */
export async function verifyRestoredErasureFences(pool, records) {
  if (!records.length) return { receipts: 0, restoredTargets: 0 };
  /** @type {import('pg').QueryResult<{present:boolean,fenced:boolean|null,sessions_revoked:boolean,recovery_revoked:boolean}>} */
  const result = await pool.query(
    `SELECT t.id IS NOT NULL AS present,
      CASE
        WHEN t.id IS NULL THEN true
        WHEN t.lifecycle='removed' THEN
          NOT EXISTS(SELECT 1 FROM users WHERE tenant_id=t.id)
          AND NOT EXISTS(SELECT 1 FROM solarman_accounts WHERE tenant_id=t.id)
          AND c.tenant_id IS NULL
        ELSE t.lifecycle='offboarding' AND o.id=r.id
          AND o.erasure_authorized_at=r."authorizedAt"
          AND c.tenant_id IS NOT NULL AND c.paused AND NOT c.control_enabled
          AND NOT c.manual_topup AND c.topup_expires_at IS NULL AND c.verification IS NULL
      END AS fenced,
      NOT EXISTS(
        SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id
        WHERE u.tenant_id=r."tenantId"
      ) AS sessions_revoked,
      NOT EXISTS(
        SELECT 1 FROM account_recovery_tokens k JOIN users u ON u.id=k.user_id
        WHERE u.tenant_id=r."tenantId" AND k.used_at IS NULL AND k.revoked_at IS NULL
      ) AS recovery_revoked
    FROM jsonb_to_recordset($1::jsonb) AS r(id uuid,"tenantId" uuid,"authorizedAt" timestamptz)
    LEFT JOIN tenants t ON t.id=r."tenantId"
    LEFT JOIN workspace_offboarding o ON o.tenant_id=t.id
    LEFT JOIN controller_state c ON c.tenant_id=t.id`,
    [JSON.stringify(records)],
  );
  if (
    result.rows.length !== records.length ||
    result.rows.some(
      (row) =>
        row.fenced !== true ||
        row.sessions_revoked !== true ||
        row.recovery_revoked !== true,
    )
  )
    throw new BackupError("restore_erasure_fence_unverified");
  return {
    receipts: records.length,
    restoredTargets: result.rows.filter((row) => row.present).length,
  };
}

/** @param {object} header @param {Buffer} dump @returns {void} */
export function validateDrill(header, dump) {
  if (
    header.version !== 1 ||
    header.database !== "solarman" ||
    !UUID.test(header.backupId) ||
    !Number.isSafeInteger(header.plainBytes) ||
    header.plainBytes !== dump.length ||
    createHash("sha256").update(dump).digest("hex") !== header.plainSha256 ||
    !header.contents ||
    !header.contents.counts ||
    typeof header.contents.counts !== "object" ||
    Array.isArray(header.contents.counts) ||
    !/^[a-f0-9]{64}$/.test(header.contents.authHash) ||
    !Array.isArray(header.contents.migrations) ||
    !Number.isSafeInteger(header.accountCount) ||
    header.accountCount < 0
  )
    throw new BackupError("drill_payload_invalid");
  encryptionKey(header.credentialKey);
  if (header.erasureReceipts !== undefined) {
    if (
      !Array.isArray(header.erasureReceipts) ||
      header.erasureReceipts.length > 50000
    )
      throw new BackupError("drill_erasure_fences_invalid");
    header.erasureReceipts.forEach(erasureReceipt);
  }
  for (const [table, count] of Object.entries(header.contents.counts))
    if (!table || !Number.isSafeInteger(count) || count < 0)
      throw new BackupError("drill_inventory_invalid");
}

/** @typedef {{password:string,user:string,email:string,pushReceipt:{id:string,attempt:string,token:string}}} AuthenticationFixture */
/** @param {import('pg').Pool} pool @param {Buffer} key @param {'attending'|'approved'} [commissioningState] @returns {Promise<AuthenticationFixture>} */
async function createAuthenticationFixture(
  pool,
  key,
  commissioningState = "attending",
) {
  const password = randomBytes(32).toString("base64url");
  const tenant = randomUUID();
  const user = randomUUID();
  const email = `restore-${user}@example.invalid`;
  await pool.query(
    "INSERT INTO tenants(id,name,lifecycle,lifecycle_message) VALUES ($1,'Isolated restore verification','suspended','Isolated recovery check')",
    [tenant],
  );
  await pool.query(
    "INSERT INTO users(id,tenant_id,email,password_hash) VALUES ($1,$2,$3,$4)",
    [user, tenant, email, await hashPassword(password)],
  );
  await pool.query(
    "INSERT INTO workspace_retention(tenant_id,enabled) VALUES($1,true)",
    [tenant],
  );
  const account = randomUUID(),
    device = `restore-observation-${account}`;
  await pool.query(
    "INSERT INTO solarman_accounts(id,tenant_id,email,credentials,device_sn,profile) VALUES($1,$2,$3,$4,$5,'bluesun-bse20kh3')",
    [
      account,
      tenant,
      `provider-${account}@example.invalid`,
      encryptCredentials(
        { passwordSha256: randomBytes(32).toString("hex") },
        key,
        tenant,
        account,
      ),
      device,
    ],
  );
  const identity = observationIdentity({
    accountId: account,
    device,
    profile: "bluesun-bse20kh3",
    timezone: "Europe/Sofia",
    firmware: { protocol: "2.02", dsp: "1.57", hmi: "1.45" },
  });
  await pool.query(
    "INSERT INTO policy_observation_runs(id,tenant_id,account_id,device,binding,identity,verification,created_by,cursor_id,progress) VALUES($1,$2,$3,$4,$5,$6,$7,$8,0,$9)",
    [
      randomUUID(),
      tenant,
      account,
      device,
      observationBinding(identity),
      identity,
      { checkedAt: new Date().toISOString(), passed: false, checks: [] },
      user,
      emptyObservationProgress(),
    ],
  );
  await pool.query(
    "INSERT INTO control_commissioning(id,tenant_id,account_id,device,binding,identity,verification,created_by,state,attended_until) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,CASE WHEN $9='attending' THEN clock_timestamp()+interval '30 minutes' ELSE null END)",
    [
      randomUUID(),
      tenant,
      account,
      device,
      observationBinding(identity),
      identity,
      { checkedAt: new Date().toISOString(), passed: false, checks: [] },
      user,
      commissioningState,
    ],
  );
  const channel = randomUUID();
  await pool.query(
    "INSERT INTO notification_channels(id,tenant_id,chat_id,secret,language,enabled,verified_at) VALUES($1,$2,'-10000001',$3,'bg',true,clock_timestamp())",
    [
      channel,
      tenant,
      encryptNotificationSecret(
        "123456789:" + randomBytes(32).toString("base64url"),
        key,
        tenant,
        channel,
      ),
    ],
  );
  for (const state of ["queued", "sending"]) {
    const id = randomUUID();
    await pool.query(
      "INSERT INTO notification_outbox(id,tenant_id,channel_id,channel_revision,event_key,kind,payload,state,attempts) VALUES($1,$2,$3,1,$4,'test',$5,$6,$7)",
      [
        id,
        tenant,
        channel,
        `restore:${state}`,
        {
          title: "Isolated recovery fixture",
          text: "Restore must never send this fixture.",
        },
        state,
        state === "sending" ? 1 : 0,
      ],
    );
    if (state === "sending")
      await pool.query(
        "INSERT INTO notification_attempts(id,tenant_id,job_id,number) VALUES($1,$2,$3,1)",
        [randomUUID(), tenant, id],
      );
  }
  let pushReceipt;
  for (const enabled of [true, false]) {
    const deviceKey = createECDH("prime256v1");
    deviceKey.generateKeys();
    const subscription = {
      endpoint: `https://web.push.apple.com/restore-${randomUUID()}`,
      keys: {
        p256dh: deviceKey.getPublicKey().toString("base64url"),
        auth: randomBytes(16).toString("base64url"),
      },
    };
    const pushChannel = randomUUID();
    await pool.query(
      "INSERT INTO notification_channels(id,tenant_id,kind,user_id,endpoint_hash,chat_id,secret,language,enabled,verified_at,push_enable_pending) VALUES($1,$2,'webpush',$3,$4,'Isolated browser fixture',$5,'bg',$6,CASE WHEN $6 THEN clock_timestamp() ELSE null END,$7)",
      [
        pushChannel,
        tenant,
        user,
        pushEndpointHash(subscription),
        encryptPushSubscription(subscription, key, tenant, pushChannel),
        enabled,
        !enabled,
      ],
    );
    for (const state of ["queued", "sending"]) {
      const id = randomUUID();
      await pool.query(
        "INSERT INTO notification_outbox(id,tenant_id,channel_id,channel_revision,event_key,kind,payload,state,attempts) VALUES($1,$2,$3,1,$4,'test',$5,$6,$7)",
        [
          id,
          tenant,
          pushChannel,
          `restore:${state}`,
          {
            title: "Isolated browser fixture",
            text: "Restore must never send this fixture.",
          },
          state,
          state === "sending" ? 1 : 0,
        ],
      );
      if (state === "sending") {
        const attempt = randomUUID();
        const token = randomBytes(32).toString("hex");
        await pool.query(
          "INSERT INTO notification_attempts(id,tenant_id,job_id,number,push_receipt_hash) VALUES($1,$2,$3,1,$4)",
          [
            attempt,
            tenant,
            id,
            createHash("sha256").update(token).digest("hex"),
          ],
        );
        if (!enabled) pushReceipt = { id, attempt, token };
      }
    }
  }
  if (!pushReceipt) throw new BackupError("restore_fixture_invalid");
  return { password, user, email, pushReceipt };
}

/** @param {import('pg').Pool} pool @param {AuthenticationFixture} fixture @param {{user:string,email:string,password:string,token:string,recoveryKey:string}} erased @param {Buffer} key @returns {Promise<void>} */
async function verifyAuthentication(
  pool,
  { password, user, email, pushReceipt },
  erased,
  key,
) {
  let accessAttempts = 0;
  const vapid = webpush.generateVAPIDKeys();
  const hub = {
    env: {
      PUBLIC_URL: "http://localhost",
      WEB_PUSH_PUBLIC_KEY: vapid.publicKey,
      WEB_PUSH_PRIVATE_KEY: vapid.privateKey,
    },
    key,
    operations: { status: () => ({ state: "current" }) },
    offboarding: { serviceStatus: async () => ({ state: "not-configured" }) },
    forTenant: async () => {
      accessAttempts++;
      throw new BackupError("device_access_forbidden");
    },
  };
  let notificationAttempts = 0;
  hub.notifications = new Notifications(pool, hub, {
    send: async () => {
      notificationAttempts++;
      throw new BackupError("notification_access_forbidden");
    },
    sendPush: async () => {
      notificationAttempts++;
      throw new BackupError("notification_access_forbidden");
    },
  });
  await hub.notifications.runOnce();
  assert.equal(notificationAttempts, 0);
  const app = createApp({
    pool,
    hub,
    config: { origin: "http://localhost", secure: false },
  });
  const server = createServer((req, res) => {
    void app(req, res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    assert.equal(
      (
        await fetch(origin + "/api/auth/session", {
          headers: { cookie: `solarman_session=${erased.token}` },
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await fetch(origin + "/api/auth/login", {
          method: "POST",
          headers: {
            origin: "http://localhost",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            email: erased.email,
            password: erased.password,
          }),
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await fetch(origin + "/api/auth/recover", {
          method: "POST",
          headers: {
            origin: "http://localhost",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            email: erased.email,
            key: erased.recoveryKey,
            newPassword: randomBytes(32).toString("base64url"),
          }),
        })
      ).status,
      400,
    );
    await assert.rejects(
      pool.query(
        "INSERT INTO sessions(user_id,token_hash,csrf_token,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')",
        [
          erased.user,
          createHash("sha256").update(randomBytes(32)).digest("hex"),
          randomBytes(32).toString("hex"),
        ],
      ),
      { code: "23514" },
    );
    const login = await fetch(origin + "/api/auth/login", {
      method: "POST",
      headers: {
        origin: "http://localhost",
        "content-type": "application/json",
      },
      body: JSON.stringify({ email, password }),
    });
    assert.equal(login.status, 200);
    let session = await login.json();
    let cookie = login.headers.get("set-cookie").split(";")[0];
    const authenticated = await fetch(origin + "/api/auth/session", {
      headers: { cookie },
    });
    assert.equal(authenticated.status, 200);
    assert.equal((await authenticated.json()).user.id, user);
    const notificationSettings = await fetch(origin + "/api/notifications", {
      headers: { cookie },
    });
    assert.equal(notificationSettings.status, 200);
    const notifications = await notificationSettings.json();
    assert.equal(notifications.channel.enabled, false);
    assert.equal(notifications.channel.quarantined, true);
    assert.equal(notifications.channel.verifiedAt, null);
    assert.equal(notifications.deliveries.length, 6);
    assert.ok(
      notifications.deliveries.every((job) => job.state === "cancelled"),
    );
    const pushSettings = await fetch(origin + "/api/notifications/push", {
      headers: { cookie },
    });
    assert.equal(pushSettings.status, 200);
    const pushDevices = (await pushSettings.json()).devices;
    assert.equal(pushDevices.length, 2);
    assert.ok(
      pushDevices.every(
        (device) =>
          !device.enabled &&
          !device.pending &&
          device.quarantined &&
          device.verifiedAt === null,
      ),
    );
    const lateReceipt = await fetch(
      origin + "/api/notifications/push/receipt",
      {
        method: "POST",
        headers: {
          origin: "http://localhost",
          "content-type": "application/json",
        },
        body: JSON.stringify(pushReceipt),
      },
    );
    assert.equal(lateReceipt.status, 202);
    const afterReceipt = await fetch(origin + "/api/notifications/push", {
      headers: { cookie },
    });
    assert.ok(
      (await afterReceipt.json()).devices.every(
        (device) => !device.enabled && !device.pending && device.quarantined,
      ),
    );
    const second = await fetch(origin + "/api/auth/login", {
      method: "POST",
      headers: {
        origin: "http://localhost",
        "content-type": "application/json",
      },
      body: JSON.stringify({ email, password }),
    });
    assert.equal(second.status, 200);
    const previous = [cookie, second.headers.get("set-cookie").split(";")[0]];
    const replacementPassword = randomBytes(32).toString("base64url");
    const changed = await fetch(origin + "/api/security/password", {
      method: "POST",
      headers: {
        cookie,
        origin: "http://localhost",
        "content-type": "application/json",
        "x-csrf-token": session.csrfToken,
      },
      body: JSON.stringify({
        currentPassword: password,
        newPassword: replacementPassword,
      }),
    });
    assert.equal(changed.status, 200);
    const renewed = await changed.json();
    assert.notEqual(renewed.csrfToken, session.csrfToken);
    session = renewed;
    cookie = changed.headers.get("set-cookie").split(";")[0];
    for (const oldCookie of previous)
      assert.equal(
        (
          await fetch(origin + "/api/auth/session", {
            headers: { cookie: oldCookie },
          })
        ).status,
        401,
      );
    const security = await fetch(origin + "/api/security", {
      headers: { cookie },
    });
    assert.equal(security.status, 200);
    const state = await security.json();
    assert.equal(state.sessionCount, 1);
    assert.ok(state.events.some((event) => event.kind === "password_changed"));
    const keyResponse = await fetch(origin + "/api/security/recovery/key", {
      method: "POST",
      headers: {
        cookie,
        origin: "http://localhost",
        "content-type": "application/json",
        "x-csrf-token": session.csrfToken,
      },
      body: JSON.stringify({ currentPassword: replacementPassword }),
    });
    assert.equal(keyResponse.status, 200);
    const saved = await keyResponse.json();
    const recoveredPassword = randomBytes(32).toString("base64url");
    const recovered = await fetch(origin + "/api/auth/recover", {
      method: "POST",
      headers: {
        origin: "http://localhost",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        email,
        key: saved.key,
        newPassword: recoveredPassword,
      }),
    });
    assert.equal(recovered.status, 200);
    assert.equal(
      (await fetch(origin + "/api/auth/session", { headers: { cookie } }))
        .status,
      401,
    );
    const signedIn = await fetch(origin + "/api/auth/login", {
      method: "POST",
      headers: {
        origin: "http://localhost",
        "content-type": "application/json",
      },
      body: JSON.stringify({ email, password: recoveredPassword }),
    });
    assert.equal(signedIn.status, 200);
    session = await signedIn.json();
    cookie = signedIn.headers.get("set-cookie").split(";")[0];
    const revoke = await fetch(origin + "/api/security/recovery/revoke", {
      method: "POST",
      headers: {
        cookie,
        origin: "http://localhost",
        "content-type": "application/json",
        "x-csrf-token": session.csrfToken,
      },
      body: JSON.stringify({ currentPassword: recoveredPassword }),
    });
    assert.equal(revoke.status, 200);
    const lifecycle = await fetch(origin + "/api/workspace/lifecycle", {
      headers: { cookie },
    });
    assert.equal(lifecycle.status, 200);
    const lifecycleState = await lifecycle.json();
    assert.equal(lifecycleState.state, "suspended");
    assert.equal(lifecycleState.message, "Isolated recovery check");
    const retention = await fetch(origin + "/api/workspace/retention", {
      headers: { cookie },
    });
    assert.equal(retention.status, 200);
    assert.equal((await retention.json()).enabled, false);
    const archive = await fetch(origin + "/api/workspace/archive", {
      method: "POST",
      headers: {
        cookie,
        origin: "http://localhost",
        "content-type": "application/json",
        "x-csrf-token": session.csrfToken,
      },
      body: JSON.stringify({ currentPassword: recoveredPassword }),
    });
    assert.equal(archive.status, 200);
    const lines = (await archive.text()).trimEnd().split("\n");
    const complete = JSON.parse(lines.at(-1));
    assert.equal(complete.type, "complete");
    assert.equal(complete.counts.workspace, 1);
    assert.equal(complete.counts.members, 1);
    assert.equal(complete.counts.observations, 1);
    const observation = lines
      .map((line) => JSON.parse(line))
      .find(
        (record) =>
          record.type === "record" && record.section === "observations",
      );
    assert.equal(observation.data.state, "invalidated");
    assert.equal(observation.data.reason, "restore");
    assert.equal(complete.counts.commissioning, 1);
    assert.equal(complete.counts.notificationChannels, 3);
    assert.equal(complete.counts.notifications, 6);
    assert.equal(complete.counts.notificationAttempts, 3);
    const commissioning = lines
      .map((line) => JSON.parse(line))
      .find(
        (record) =>
          record.type === "record" && record.section === "commissioning",
      );
    assert.equal(commissioning.data.state, "invalidated");
    assert.equal(commissioning.data.reason, "restore");
    assert.equal(commissioning.data.attended_until, null);
    assert.equal(
      complete.sha256,
      createHash("sha256")
        .update(lines.slice(0, -1).join("\n") + "\n")
        .digest("hex"),
    );
    assert.equal(
      (await fetch(origin + "/api/security", { headers: { cookie } })).status,
      200,
    );
    // Account recovery must preserve suspension rather than making a restored tenant available.
    assert.equal(
      (
        await pool.query(
          "SELECT lifecycle FROM tenants WHERE id=(SELECT tenant_id FROM users WHERE id=$1)",
          [user],
        )
      ).rows[0].lifecycle,
      "suspended",
    );
    const logout = await fetch(origin + "/api/auth/logout", {
      method: "POST",
      headers: {
        cookie,
        origin: "http://localhost",
        "x-csrf-token": session.csrfToken,
      },
    });
    assert.equal(logout.status, 200);
    assert.equal(
      (await fetch(origin + "/api/auth/session", { headers: { cookie } }))
        .status,
      401,
    );
    assert.equal(accessAttempts, 0);
  } finally {
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeIdleConnections();
    });
  }
}

/** @param {object} header @param {Buffer} dump @returns {Promise<object>} */
export async function restoreDrill(header, dump) {
  validateDrill(header, dump);
  const id = randomUUID();
  const name = `solarman_drill_${id.replaceAll("-", "")}`;
  const password = randomBytes(32).toString("base64url");
  const environment = { ...process.env };
  for (const key of Object.keys(environment))
    if (key.startsWith("PG")) delete environment[key];
  const postgres = async (binary, args, input = Buffer.alloc(0)) =>
    runBuffered("runuser", ["-u", "postgres", "--", binary, ...args], input, {
      env: environment,
    });
  let roleCreated = false;
  let databaseCreated = false;
  let pool;
  const startedAt = new Date().toISOString();
  let stage = "sandbox_creation";
  const report = {
    version: 1,
    id,
    backupId: header.backupId,
    startedAt,
    state: "running",
  };
  try {
    await postgres(
      "psql",
      ["-X", "-v", "ON_ERROR_STOP=1", "-d", "postgres"],
      Buffer.from(
        `CREATE ROLE ${identifier(name)} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;`,
      ),
    );
    roleCreated = true;
    await postgres("createdb", ["--template=template0", "--owner", name, name]);
    databaseCreated = true;
    await postgres(
      "psql",
      ["-X", "-v", "ON_ERROR_STOP=1", "-d", "postgres"],
      Buffer.from(
        `REVOKE CONNECT ON DATABASE ${identifier(name)} FROM PUBLIC;`,
      ),
    );
    // Older cluster templates can leave public owned by postgres rather than the database owner.
    await postgres(
      "psql",
      ["-X", "-v", "ON_ERROR_STOP=1", "-d", name],
      Buffer.from(
        `ALTER SCHEMA public OWNER TO ${identifier(name)}; REVOKE ALL ON SCHEMA public FROM PUBLIC;`,
      ),
    );
    stage = "database_restore";
    await runBuffered(
      "pg_restore",
      ["--exit-on-error", "--no-owner", "--no-acl", "--dbname", name],
      dump,
      {
        env: {
          ...environment,
          PGHOST: "127.0.0.1",
          PGPORT: "5432",
          PGUSER: name,
          PGPASSWORD: password,
        },
      },
    );
    pool = createPool({
      host: "127.0.0.1",
      port: 5432,
      database: name,
      user: name,
      password,
      max: 2,
      connectionTimeoutMillis: 5000,
    });
    stage = "inventory_validation";
    const connection = await pool.connect();
    try {
      await connection.query("BEGIN READ ONLY");
      await connection.query("SET LOCAL TIME ZONE 'UTC'");
      assert.equal(
        (await connection.query("SELECT current_database() AS name")).rows[0]
          .name,
        name,
      );
      assert.deepEqual(await inventory(connection), header.contents);
      const users = (await connection.query("SELECT password_hash FROM users"))
        .rows;
      assert.ok(users.every((user) => validPasswordHash(user.password_hash)));
      assert.equal(
        await verifyStoredCredentials(
          connection,
          encryptionKey(header.credentialKey),
        ),
        header.accountCount,
      );
      await verifyStoredNotificationSecrets(
        connection,
        encryptionKey(header.credentialKey),
      );
      await connection.query("COMMIT");
    } finally {
      connection.release();
    }
    stage = "schema_upgrade";
    await migrate(pool);
    report.migrationsApplied = (
      await pool.query("SELECT version FROM schema_migrations ORDER BY version")
    ).rows
      .map((row) => row.version)
      .filter((version) => !header.contents.migrations.includes(version));
    stage = "erasure_fences";
    const closure = new WorkspaceOffboarding(pool, {}, { guardFile: null });
    await closure.replay(header.erasureReceipts ?? []);
    const erasureProof = await verifyRestoredErasureFences(
      pool,
      header.erasureReceipts ?? [],
    );
    report.erasureReceiptsVerified = erasureProof.receipts;
    report.restoredErasureTargets = erasureProof.restoredTargets;
    stage = "quarantine";
    const erasureTenant = randomUUID(),
      erasureUser = randomUUID();
    const erased = {
      user: erasureUser,
      email: `fence-${erasureUser}@example.invalid`,
      password: randomBytes(32).toString("base64url"),
      token: randomBytes(32).toString("hex"),
      recoveryKey: randomBytes(32).toString("base64url"),
    };
    await pool.query(
      "INSERT INTO tenants(id,name) VALUES($1,'Isolated erasure fence')",
      [erasureTenant],
    );
    await pool.query(
      "INSERT INTO users(id,tenant_id,email,password_hash) VALUES($1,$2,$3,$4)",
      [
        erasureUser,
        erasureTenant,
        erased.email,
        await hashPassword(erased.password),
      ],
    );
    await pool.query(
      "INSERT INTO controller_state(tenant_id,control_enabled,paused) VALUES($1,true,false)",
      [erasureTenant],
    );
    await pool.query(
      "INSERT INTO sessions(user_id,token_hash,csrf_token,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')",
      [
        erasureUser,
        createHash("sha256").update(erased.token).digest("hex"),
        randomBytes(32).toString("hex"),
      ],
    );
    await pool.query(
      "INSERT INTO account_recovery_tokens(user_id,token_hash,kind) VALUES($1,$2,'saved_key')",
      [
        erasureUser,
        createHash("sha256").update(erased.recoveryKey).digest("hex"),
      ],
    );
    const fence = erasureReceipt({
      version: 1,
      id: randomUUID(),
      tenantId: erasureTenant,
      authorizedAt: new Date().toISOString(),
    });
    await closure.replay([fence]);
    const fenced = (
      await pool.query(
        "SELECT t.lifecycle,c.control_enabled,c.paused,o.id,o.erasure_authorized_at FROM tenants t JOIN controller_state c ON c.tenant_id=t.id JOIN workspace_offboarding o ON o.tenant_id=t.id WHERE t.id=$1",
        [erasureTenant],
      )
    ).rows[0];
    assert.equal(fenced.lifecycle, "offboarding");
    assert.equal(fenced.control_enabled, false);
    assert.equal(fenced.paused, true);
    assert.equal(fenced.id, fence.id);
    const authenticationFixture = await createAuthenticationFixture(
      pool,
      encryptionKey(header.credentialKey),
    );
    await createAuthenticationFixture(
      pool,
      encryptionKey(header.credentialKey),
      "approved",
    );
    for (const state of ["attending", "approved"])
      assert.ok(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM control_commissioning WHERE state=$1",
            [state],
          )
        ).rows[0].n > 0,
      );
    await invalidateCommissioning(pool, null, "restore");
    assert.ok(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM notification_channels WHERE enabled",
        )
      ).rows[0].n >= 2,
    );
    await quarantineNotifications(pool, null, "restore");
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM notification_channels WHERE enabled OR push_enable_pending OR NOT quarantined OR verified_at IS NOT NULL",
        )
      ).rows[0].n,
      0,
    );
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM notification_outbox WHERE state IN('queued','retry','sending')",
        )
      ).rows[0].n,
      0,
    );
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM notification_attempts WHERE state='sending'",
        )
      ).rows[0].n,
      0,
    );
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM control_commissioning WHERE state<>'invalidated' OR attended_until IS NOT NULL",
        )
      ).rows[0].n,
      0,
    );
    assert.ok(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM policy_observation_runs WHERE state='observing'",
        )
      ).rows[0].n > 0,
    );
    await quarantineObservationRuns(pool);
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM policy_observation_runs WHERE state='observing'",
        )
      ).rows[0].n,
      0,
    );
    assert.ok(
      (
        await pool.query(
          "SELECT count(*)::integer AS n FROM workspace_retention WHERE enabled",
        )
      ).rows[0].n > 0,
    );
    await pool.query(
      "UPDATE workspace_retention SET enabled=false,revision=revision+1,updated_at=clock_timestamp() WHERE enabled",
    );
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::integer AS n FROM workspace_retention WHERE enabled",
        )
      ).rows[0].n,
      0,
    );
    await pool.query(
      `INSERT INTO account_recovery_tokens (user_id,token_hash,kind,expires_at) VALUES
      ($1,$2,'saved_key',null),($1,$3,'admin_link',clock_timestamp()+interval '1 hour')`,
      [
        authenticationFixture.user,
        createHash("sha256").update(randomBytes(32)).digest("hex"),
        createHash("sha256").update(randomBytes(32)).digest("hex"),
      ],
    );
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM account_recovery_tokens WHERE user_id=$1 AND used_at IS NULL AND revoked_at IS NULL",
          [authenticationFixture.user],
        )
      ).rows[0].n,
      2,
    );
    await pool.query(
      "UPDATE controller_state SET paused=true,manual_topup=false,control_enabled=false,verification=null,topup_expires_at=null,control_epoch=control_epoch+1",
    );
    await pool.query(
      "UPDATE device_control_state SET state='cleanup-required' WHERE state<>'clear'",
    );
    await pool.query("DELETE FROM sessions");
    await pool.query(
      "UPDATE account_recovery_tokens SET revoked_at=now() WHERE used_at IS NULL AND revoked_at IS NULL",
    );
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM account_recovery_tokens WHERE used_at IS NULL AND revoked_at IS NULL",
        )
      ).rows[0].n,
      0,
    );
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM controller_state WHERE NOT paused OR manual_topup OR control_enabled",
        )
      ).rows[0].count,
      0,
    );
    stage = "authentication";
    await verifyAuthentication(
      pool,
      authenticationFixture,
      erased,
      encryptionKey(header.credentialKey),
    );
    Object.assign(report, {
      state: "verified",
      inventoryVerified: true,
      credentialsVerified: true,
      authenticationVerified: true,
      accountSecurityVerified: true,
      accountRecoveryVerified: true,
      tenantLifecycleVerified: true,
      retentionQuarantined: true,
      workspaceExportVerified: true,
      erasureFencesVerified: true,
      observationsQuarantined: true,
      commissioningQuarantined: true,
      notificationsQuarantined: true,
      notificationAccessAttempts: 0,
      recoveryQuarantined: true,
      schemaUpgradeVerified: true,
      controlQuarantined: true,
      deviceAccessAttempts: 0,
    });
  } catch (error) {
    report.state = "failed";
    report.code = stage;
  } finally {
    await pool?.end();
    if (databaseCreated) {
      try {
        await postgres("dropdb", ["--force", name]);
      } catch {
        report.state = "failed";
        report.code = "database_cleanup_failed";
      }
    }
    if (roleCreated) {
      try {
        await postgres(
          "psql",
          ["-X", "-v", "ON_ERROR_STOP=1", "-d", "postgres"],
          Buffer.from(`DROP ROLE ${identifier(name)};`),
        );
      } catch {
        report.state = "failed";
        report.code = "role_cleanup_failed";
      }
    }
    report.completedAt = new Date().toISOString();
  }
  return report;
}
