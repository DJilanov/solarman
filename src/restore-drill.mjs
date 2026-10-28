import { randomBytes, randomUUID, createHash } from "node:crypto";
import { createServer } from "node:http";
import assert from "node:assert/strict";
import { createPool, migrate } from "./database.mjs";
import { createApp } from "./http-app.mjs";
import { hashPassword, validPasswordHash } from "./auth.mjs";
import { decryptCredentials, encryptionKey } from "./credentials.mjs";
import {
  BackupError,
  identifier,
  inventory,
  runBuffered,
  UUID,
} from "./backup-io.mjs";

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
  for (const [table, count] of Object.entries(header.contents.counts))
    if (!table || !Number.isSafeInteger(count) || count < 0)
      throw new BackupError("drill_inventory_invalid");
}

/** @typedef {{password:string,user:string,email:string}} AuthenticationFixture */
/** @param {import('pg').Pool} pool @returns {Promise<AuthenticationFixture>} */
async function createAuthenticationFixture(pool) {
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
  return { password, user, email };
}

/** @param {import('pg').Pool} pool @param {AuthenticationFixture} fixture @returns {Promise<void>} */
async function verifyAuthentication(pool, { password, user, email }) {
  let accessAttempts = 0;
  const hub = {
    forTenant: async () => {
      accessAttempts++;
      throw new BackupError("device_access_forbidden");
    },
  };
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
      const accounts = (
        await connection.query(
          "SELECT tenant_id,id,credentials FROM solarman_accounts",
        )
      ).rows;
      assert.equal(accounts.length, header.accountCount);
      const key = encryptionKey(header.credentialKey);
      for (const account of accounts)
        decryptCredentials(
          account.credentials,
          key,
          account.tenant_id,
          account.id,
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
    stage = "quarantine";
    const authenticationFixture = await createAuthenticationFixture(pool);
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
    await verifyAuthentication(pool, authenticationFixture);
    Object.assign(report, {
      state: "verified",
      inventoryVerified: true,
      credentialsVerified: true,
      authenticationVerified: true,
      accountSecurityVerified: true,
      accountRecoveryVerified: true,
      tenantLifecycleVerified: true,
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
