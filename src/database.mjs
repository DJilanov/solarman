import pg from "pg";
import { readFile, readdir } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import { encryptCredentials } from "./credentials.mjs";

/** @param {object} options @returns {pg.Pool} */
export function createPool(options) {
  const pool = new pg.Pool(options);
  pool.on("error", () =>
    console.error(JSON.stringify({ event: "database_connection_error" })),
  );
  return pool;
}

/** @param {pg.Pool} pool @returns {Promise<void>} */
export async function migrate(pool) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(193401, 1)");
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const directory = new URL("../migrations/", import.meta.url);
    const files = (await readdir(directory))
      .filter((name) => /^\d{3}_[a-z_]+\.sql$/.test(name))
      .sort();
    for (const name of files) {
      if (
        (
          await client.query(
            "SELECT 1 FROM schema_migrations WHERE version=$1",
            [name],
          )
        ).rowCount
      )
        continue;
      await client.query(await readFile(new URL(name, directory), "utf8"));
      await client.query(
        "INSERT INTO schema_migrations (version) VALUES ($1)",
        [name],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** @param {pg.Pool} pool @param {string} email @param {string} passwordHash @param {Buffer} key @param {Record<string, string | undefined>} env @returns {Promise<void>} */
export async function bootstrapAdmin(pool, email, passwordHash, key, env) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(193401,3)");
    if (
      (await client.query("SELECT 1 FROM users WHERE lower(email)=$1", [email]))
        .rowCount
    ) {
      await client.query("COMMIT");
      return;
    }
    const tenantId = randomUUID();
    const accountId = randomUUID();
    await client.query(
      "INSERT INTO tenants (id,name) VALUES ($1,'My solar workspace')",
      [tenantId],
    );
    await client.query(
      "INSERT INTO users (id,tenant_id,email,password_hash,platform_admin) VALUES ($1,$2,$3,$4,true)",
      [randomUUID(), tenantId, email, passwordHash],
    );
    await client.query("INSERT INTO controller_state (tenant_id) VALUES ($1)", [
      tenantId,
    ]);
    const providerHash =
      env.SOLARMAN_PASSWORD_SHA256?.trim() ||
      (env.SOLARMAN_PASSWORD
        ? createHash("sha256").update(env.SOLARMAN_PASSWORD).digest("hex")
        : null);
    if (env.SOLARMAN_EMAIL && providerHash) {
      await client.query(
        `INSERT INTO solarman_accounts (id,tenant_id,email,credentials,device_sn,profile)
        VALUES ($1,$2,$3,$4,$5,'bluesun-bse20kh3')`,
        [
          accountId,
          tenantId,
          env.SOLARMAN_EMAIL,
          encryptCredentials(
            { passwordSha256: providerHash },
            key,
            tenantId,
            accountId,
          ),
          env.SOLARMAN_DEVICE_SN || null,
        ],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** @param {pg.Pool} pool @param {string} tenantId @param {string} accountId @param {string} device @param {object} snapshot @returns {Promise<void>} */
export async function saveMeasurement(
  pool,
  tenantId,
  accountId,
  device,
  snapshot,
) {
  await pool.query(
    `INSERT INTO measurements
    (tenant_id,account_id,device,observed_at,soc,temperature_c,pv_w,load_w,grid_w,battery_w,ac_enabled,snapshot)
    VALUES ($1,$2,$3,now(),$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      tenantId,
      accountId,
      device,
      snapshot.soc,
      snapshot.temperatureC,
      snapshot.pvW,
      snapshot.loadW,
      snapshot.gridW,
      snapshot.batteryW,
      Boolean(snapshot.flags & 16),
      snapshot,
    ],
  );
}
