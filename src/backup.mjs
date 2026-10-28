import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { parseEnv } from "node:util";
import {
  S3Client,
  HeadBucketCommand,
  CreateBucketCommand,
  PutPublicAccessBlockCommand,
  PutBucketEncryptionCommand,
  PutBucketVersioningCommand,
  PutBucketLifecycleConfigurationCommand,
  GetPublicAccessBlockCommand,
  GetBucketEncryptionCommand,
  GetBucketVersioningCommand,
  GetBucketLifecycleConfigurationCommand,
  PutObjectCommand,
  HeadObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { createPool } from "./database.mjs";
import { dashboardConfig } from "./dashboard-config.mjs";
import { decryptCredentials, encryptionKey } from "./credentials.mjs";
import {
  atomicJson,
  BackupError,
  childProcess,
  encryptStream,
  fingerprint,
  inventory,
  UUID,
} from "./backup-io.mjs";

/** @param {object} config @returns {Promise<S3Client>} */
export async function backupClient(config) {
  const env = parseEnv(await readFile(config.awsEnv, "utf8"));
  if (
    !/^[a-z0-9.-]+\.amazonaws\.com$/.test(env.MINIO_ENDPOINT ?? "") ||
    !env.MINIO_ROOT_USER ||
    !env.MINIO_ROOT_PASSWORD
  )
    throw new BackupError("offsite_credentials_invalid");
  return new S3Client({
    region: config.region,
    credentials: {
      accessKeyId: env.MINIO_ROOT_USER,
      secretAccessKey: env.MINIO_ROOT_PASSWORD,
    },
    maxAttempts: 3,
  });
}

/** @param {S3Client} client @param {object} config @returns {Promise<void>} */
export async function verifyBucket(client, config) {
  const [access, encryption, versioning, lifecycle] = await Promise.all([
    client.send(new GetPublicAccessBlockCommand({ Bucket: config.bucket })),
    client.send(new GetBucketEncryptionCommand({ Bucket: config.bucket })),
    client.send(new GetBucketVersioningCommand({ Bucket: config.bucket })),
    client.send(
      new GetBucketLifecycleConfigurationCommand({ Bucket: config.bucket }),
    ),
  ]);
  if (
    ![
      "BlockPublicAcls",
      "IgnorePublicAcls",
      "BlockPublicPolicy",
      "RestrictPublicBuckets",
    ].every((key) => access.PublicAccessBlockConfiguration?.[key] === true) ||
    !encryption.ServerSideEncryptionConfiguration?.Rules?.some(
      (rule) =>
        rule.ApplyServerSideEncryptionByDefault?.SSEAlgorithm === "AES256",
    ) ||
    versioning.Status !== "Enabled" ||
    !lifecycle.Rules?.some(
      (rule) =>
        rule.Status === "Enabled" &&
        rule.Filter?.Prefix === "runs/" &&
        rule.Expiration?.Days === 30 &&
        rule.NoncurrentVersionExpiration?.NoncurrentDays === 30,
    )
  )
    throw new BackupError("offsite_protection_invalid");
}

/** @param {S3Client} client @param {object} config @returns {Promise<void>} */
export async function configureBucket(client, config) {
  try {
    await client.send(new HeadBucketCommand({ Bucket: config.bucket }));
  } catch (error) {
    if (error.$metadata?.httpStatusCode !== 404 && error.name !== "NotFound")
      throw error;
    await client.send(
      new CreateBucketCommand({
        Bucket: config.bucket,
        ObjectOwnership: "BucketOwnerEnforced",
        ...(config.region === "us-east-1"
          ? {}
          : {
              CreateBucketConfiguration: { LocationConstraint: config.region },
            }),
      }),
    );
  }
  await client.send(
    new PutPublicAccessBlockCommand({
      Bucket: config.bucket,
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        IgnorePublicAcls: true,
        BlockPublicPolicy: true,
        RestrictPublicBuckets: true,
      },
    }),
  );
  await client.send(
    new PutBucketEncryptionCommand({
      Bucket: config.bucket,
      ServerSideEncryptionConfiguration: {
        Rules: [
          { ApplyServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } },
        ],
      },
    }),
  );
  await client.send(
    new PutBucketVersioningCommand({
      Bucket: config.bucket,
      VersioningConfiguration: { Status: "Enabled" },
    }),
  );
  await client.send(
    new PutBucketLifecycleConfigurationCommand({
      Bucket: config.bucket,
      LifecycleConfiguration: {
        Rules: [
          {
            ID: "solarman-retention",
            Status: "Enabled",
            Filter: { Prefix: "runs/" },
            Expiration: { Days: 30 },
            NoncurrentVersionExpiration: { NoncurrentDays: 30 },
            AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 },
          },
        ],
      },
    }),
  );
  await verifyBucket(client, config);
}

/** @param {S3Client} client @param {object} config @param {string} id @param {string} kind @param {string} file @returns {Promise<object>} */
async function upload(client, config, id, kind, file) {
  const expected = await fingerprint(file);
  const key = `runs/${id}/${kind}.age`;
  const saved = await client.send(
    new PutObjectCommand({
      Bucket: config.bucket,
      Key: key,
      Body: createReadStream(file),
      ContentLength: expected.bytes,
      ChecksumSHA256: Buffer.from(expected.sha256, "hex").toString("base64"),
      Metadata: { sha256: expected.sha256 },
      ServerSideEncryption: "AES256",
    }),
  );
  if (!saved.VersionId) throw new BackupError("offsite_version_missing");
  const reference = { key, versionId: saved.VersionId, ...expected };
  const head = await client.send(
    new HeadObjectCommand({
      Bucket: config.bucket,
      Key: key,
      VersionId: saved.VersionId,
    }),
  );
  if (
    head.ContentLength !== expected.bytes ||
    head.ServerSideEncryption !== "AES256" ||
    head.Metadata?.sha256 !== expected.sha256
  )
    throw new BackupError("offsite_metadata_mismatch");
  const body = await client.send(
    new GetObjectCommand({
      Bucket: config.bucket,
      Key: key,
      VersionId: saved.VersionId,
    }),
  );
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of body.Body) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  if (bytes !== expected.bytes || hash.digest("hex") !== expected.sha256)
    throw new BackupError("offsite_checksum_mismatch");
  return reference;
}

/** @param {object} config @param {object} patch @returns {Promise<void>} */
export async function updateStatus(config, patch) {
  const file = path.join(config.stateDirectory, "public", "status.json");
  await mkdir(config.stateDirectory, { recursive: true, mode: 0o700 });
  const lock = await open(
    path.join(config.stateDirectory, "status.lock"),
    "a",
    0o600,
  );
  try {
    // The inherited descriptor keeps the Linux flock held until this handle closes.
    const held = spawnSync("flock", ["--exclusive", "--wait", "5", "3"], {
      stdio: ["ignore", "ignore", "ignore", lock.fd],
      timeout: 6000,
    });
    if (held.status !== 0) throw new BackupError("status_lock_failed");
    let previous = {};
    try {
      previous = JSON.parse(await readFile(file, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await atomicJson(
      file,
      { ...previous, ...patch, version: 1, retentionDays: 30 },
      0o640,
    );
  } finally {
    await lock.close();
  }
}

/** @param {S3Client} client @param {object} config @returns {Promise<object>} */
export async function runBackup(client, config) {
  const id = randomUUID();
  const startedAt = new Date().toISOString();
  const work = path.join(config.stateDirectory, "work", id);
  await mkdir(work, { recursive: true, mode: 0o700 });
  let pool;
  let connection;
  let stage = "configuration";
  try {
    const raw = await readFile(config.appEnv);
    const originalHash = createHash("sha256").update(raw).digest("hex");
    const env = parseEnv(raw.toString("utf8"));
    const database = dashboardConfig(env).database;
    if (database.database !== config.database || database.host !== "127.0.0.1")
      throw new BackupError("database_identity");
    const key = encryptionKey(env.CREDENTIAL_ENCRYPTION_KEY);
    pool = createPool({ ...database, max: 1 });
    connection = await pool.connect();
    if (
      !(await connection.query("SELECT pg_try_advisory_lock(193401,4) AS held"))
        .rows[0].held
    )
      throw new BackupError("backup_already_running");
    await updateStatus(config, {
      backup: { id, state: "running", startedAt, completedAt: null },
    });
    stage = "snapshot";
    await connection.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await connection.query("SET LOCAL TIME ZONE 'UTC'");
    if (
      (await connection.query("SELECT current_database() AS name")).rows[0]
        .name !== config.database
    )
      throw new BackupError("database_identity");
    const contents = await inventory(connection);
    const accounts = (
      await connection.query(
        "SELECT tenant_id,id,credentials FROM solarman_accounts",
      )
    ).rows;
    for (const account of accounts)
      decryptCredentials(
        account.credentials,
        key,
        account.tenant_id,
        account.id,
      );
    const snapshot = (
      await connection.query("SELECT pg_export_snapshot() AS id")
    ).rows[0].id;
    stage = "database_dump";
    const dump = childProcess(
      "pg_dump",
      [
        "--format=custom",
        "--no-owner",
        "--no-acl",
        `--snapshot=${snapshot}`,
        "--dbname",
        config.database,
      ],
      {
        env: {
          ...process.env,
          PGHOST: database.host,
          PGPORT: String(database.port),
          PGUSER: database.user,
          PGPASSWORD: database.password,
        },
        timeout: 900000,
      },
    );
    let plainBytes = 0;
    try {
      [, plainBytes] = await Promise.all([
        dump.done,
        encryptStream(
          config.age,
          config.recipientFile,
          dump.child.stdout,
          path.join(work, "database.age"),
        ),
      ]);
    } finally {
      dump.child.kill("SIGKILL");
      await dump.done.catch(() => {});
    }
    await connection.query("COMMIT");
    stage = "configuration_encryption";
    await encryptStream(
      config.age,
      config.recipientFile,
      [raw],
      path.join(work, "configuration.age"),
    );
    if (
      createHash("sha256")
        .update(await readFile(config.appEnv))
        .digest("hex") !== originalHash
    )
      throw new BackupError("configuration_changed");
    stage = "offsite_upload";
    await verifyBucket(client, config);
    const databaseObject = await upload(
      client,
      config,
      id,
      "database",
      path.join(work, "database.age"),
    );
    const configurationObject = await upload(
      client,
      config,
      id,
      "configuration",
      path.join(work, "configuration.age"),
    );
    const manifest = {
      version: 1,
      id,
      database: config.database,
      startedAt,
      contents,
      accountCount: accounts.length,
      plainBytes,
      databaseObject,
      configurationObject,
    };
    await encryptStream(
      config.age,
      config.recipientFile,
      [Buffer.from(JSON.stringify(manifest))],
      path.join(work, "manifest.age"),
    );
    const manifestObject = await upload(
      client,
      config,
      id,
      "manifest",
      path.join(work, "manifest.age"),
    );
    const result = {
      version: 1,
      id,
      state: "verified",
      startedAt,
      completedAt: new Date().toISOString(),
      databaseObject,
      configurationObject,
      manifestObject,
    };
    await atomicJson(
      path.join(config.stateDirectory, "runs", `${id}.json`),
      result,
    );
    await atomicJson(path.join(config.stateDirectory, "latest.json"), result);
    await updateStatus(config, {
      backup: {
        id,
        state: "verified",
        startedAt,
        completedAt: result.completedAt,
        offsiteVerified: true,
        bytes:
          databaseObject.bytes +
          configurationObject.bytes +
          manifestObject.bytes,
      },
      lastBackupAt: result.completedAt,
    });
    return result;
  } catch (error) {
    if (error.code !== "backup_already_running")
      await updateStatus(config, {
        backup: {
          id,
          state: "failed",
          startedAt,
          completedAt: new Date().toISOString(),
          code: stage,
        },
      });
    throw new BackupError(error instanceof BackupError ? error.code : stage);
  } finally {
    if (connection) {
      await connection.query("ROLLBACK").catch(() => {});
      connection.release();
    }
    await pool?.end();
    await rm(work, { recursive: true, force: true });
  }
}

/** @param {object} config @param {string} id @returns {Promise<object>} */
export async function receipt(config, id) {
  if (!UUID.test(id)) throw new BackupError("run_id_invalid");
  const value = JSON.parse(
    await readFile(
      path.join(config.stateDirectory, "runs", `${id}.json`),
      "utf8",
    ),
  );
  if (value.version !== 1 || value.id !== id || value.state !== "verified")
    throw new BackupError("receipt_invalid");
  for (const kind of ["database", "configuration", "manifest"])
    validateObject(value[`${kind}Object`], id, kind);
  return value;
}

/** @param {object} reference @param {string} id @param {string} kind @returns {void} */
export function validateObject(reference, id, kind) {
  if (
    !UUID.test(id) ||
    !["database", "configuration", "manifest"].includes(kind) ||
    reference?.key !== `runs/${id}/${kind}.age` ||
    typeof reference.versionId !== "string" ||
    !reference.versionId ||
    !/^[a-f0-9]{64}$/.test(reference.sha256) ||
    !Number.isSafeInteger(reference.bytes) ||
    reference.bytes < 1
  )
    throw new BackupError("object_reference_invalid");
}
