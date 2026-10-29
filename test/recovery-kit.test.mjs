import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { S3Client } from "@aws-sdk/client-s3";
import { backupCredentials } from "../src/backup.mjs";
import { BackupError, runBuffered } from "../src/backup-io.mjs";
import {
  encryptRecoveryKit,
  readPrivateRecoveryFile,
  recoveryKit,
  verifyRecoveryKit,
  writePrivateRecoveryFile,
} from "../src/recovery-kit.mjs";

const age = [
  process.env.BACKUP_AGE_BINARY,
  path.join(homedir(), ".local/share/solarman-tools/age-v1.3.2/age"),
  "/opt/solarman-tools/age-v1.3.2/age",
].find((file) => file && existsSync(file));

function kitFixture() {
  const now = new Date().toISOString(),
    id = randomUUID();
  const reference = (kind) => ({
    key: `runs/${id}/${kind}.age`,
    versionId: `${kind}-version`,
    bytes: 100,
    sha256: "b".repeat(64),
  });
  return {
    version: 1,
    createdAt: now,
    location: {
      bucket: "jilanov-solarman-backups-1234abcd",
      region: "eu-central-1",
      recipient: "ssh-ed25519 AAAA",
    },
    credentials: {
      accessKeyId: "fixture-access-key",
      secretAccessKey: "fixture-private-credential",
    },
    receipt: {
      version: 1,
      id,
      state: "verified",
      startedAt: now,
      completedAt: now,
      databaseObject: reference("database"),
      configurationObject: reference("configuration"),
      manifestObject: reference("manifest"),
    },
    erasureReceipts: [
      {
        version: 1,
        id: randomUUID(),
        tenantId: randomUUID(),
        authorizedAt: now,
      },
    ],
  };
}

async function encryptedFixture(t) {
  const directory = await mkdtemp(
    path.join(tmpdir(), "solarman-recovery-kit-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const identity = path.join(directory, "identity");
  await runBuffered(
    "ssh-keygen",
    ["-q", "-t", "ed25519", "-N", "", "-f", identity],
    Buffer.alloc(0),
  );
  const kit = kitFixture();
  kit.location.recipient = (await readFile(identity + ".pub", "utf8"))
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .join(" ");
  const objects = new Map();
  const encryptedObject = async (kind, body) => {
    const ciphertext = await runBuffered(
      age,
      ["--encrypt", "--recipient", kit.location.recipient],
      body,
    );
    const object = {
      key: `runs/${kit.receipt.id}/${kind}.age`,
      versionId: kind + "-version",
      bytes: ciphertext.length,
      sha256: createHash("sha256").update(ciphertext).digest("hex"),
    };
    objects.set(object.key, { object, body: ciphertext });
    return object;
  };
  const dump = Buffer.from("PGDMP-isolated-archive-fixture");
  kit.receipt.databaseObject = await encryptedObject("database", dump);
  kit.receipt.configurationObject = await encryptedObject(
    "configuration",
    Buffer.from(
      "CREDENTIAL_ENCRYPTION_KEY=" +
        Buffer.alloc(32, 4).toString("base64") +
        "\nSOLARMAN_PASSWORD=provider-private-fixture\n",
    ),
  );
  const manifest = {
    version: 1,
    id: kit.receipt.id,
    database: "solarman",
    startedAt: kit.createdAt,
    contents: {
      counts: { users: 0 },
      authHash: "a".repeat(64),
      migrations: ["001_dashboard.sql"],
    },
    accountCount: 0,
    plainBytes: dump.length,
    databaseObject: kit.receipt.databaseObject,
    configurationObject: kit.receipt.configurationObject,
  };
  kit.receipt.manifestObject = await encryptedObject(
    "manifest",
    Buffer.from(JSON.stringify(manifest)),
  );
  const current = new Map(
    kit.erasureReceipts.map((record) => [record.id, structuredClone(record)]),
  );
  const calls = [];
  const fixture = {
    kit,
    objects,
    current,
    calls,
    identity,
    dump,
    tamper: false,
    wrongVersion: false,
    repeatToken: false,
  };
  t.mock.method(S3Client.prototype, "send", async (command) => {
    const name = command.constructor.name;
    calls.push({ name, input: command.input });
    assert.equal(command.input.Bucket, kit.location.bucket);
    switch (name) {
      case "GetPublicAccessBlockCommand":
        return {
          PublicAccessBlockConfiguration: {
            BlockPublicAcls: true,
            IgnorePublicAcls: true,
            BlockPublicPolicy: true,
            RestrictPublicBuckets: true,
          },
        };
      case "GetBucketEncryptionCommand":
        return {
          ServerSideEncryptionConfiguration: {
            Rules: [
              {
                ApplyServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" },
              },
            ],
          },
        };
      case "GetBucketVersioningCommand":
        return { Status: "Enabled" };
      case "GetBucketLifecycleConfigurationCommand":
        return {
          Rules: [
            {
              Status: "Enabled",
              Filter: { Prefix: "runs/" },
              Expiration: { Days: 30 },
              NoncurrentVersionExpiration: { NoncurrentDays: 30 },
            },
          ],
        };
      case "ListObjectsV2Command":
        assert.equal(command.input.Prefix, "erasures/");
        return {
          Contents: [...current.keys()].map((id) => ({
            Key: `erasures/${id}.json`,
          })),
          ...(fixture.repeatToken
            ? { IsTruncated: true, NextContinuationToken: "same-page" }
            : { IsTruncated: false }),
        };
      case "GetObjectCommand": {
        if (command.input.Key.startsWith("erasures/")) {
          const body = Buffer.from(
            JSON.stringify(current.get(command.input.Key.slice(9, -5))),
          );
          return {
            Body: Readable.from([body]),
            ServerSideEncryption: "AES256",
            VersionId: "receipt-version",
            ETag: "fixture-etag",
            Metadata: {
              sha256: createHash("sha256").update(body).digest("hex"),
            },
          };
        }
        const saved = objects.get(command.input.Key);
        assert.ok(saved, "Unknown object");
        assert.equal(command.input.VersionId, saved.object.versionId);
        const body = Buffer.from(saved.body);
        if (fixture.tamper) body[body.length - 1] ^= 1;
        return {
          Body: Readable.from([body]),
          ServerSideEncryption: "AES256",
          VersionId: fixture.wrongVersion
            ? "wrong-version"
            : saved.object.versionId,
          ContentLength: body.length,
          Metadata: { sha256: saved.object.sha256 },
        };
      }
      default:
        throw new Error("Unexpected write or external operation: " + name);
    }
  });
  fixture.encrypted = await encryptRecoveryKit(kit, age);
  return fixture;
}

test("recovery kits restrict locations, verified versions, credentials and erasure baselines", () => {
  const kit = kitFixture();
  assert.doesNotThrow(() => recoveryKit(kit));
  for (const change of [
    (value) => {
      value.location.bucket = "another-application";
    },
    (value) => {
      value.location.endpoint = "https://untrusted.example";
    },
    (value) => {
      value.credentials.providerPassword = "unexpected";
    },
    (value) => {
      value.credentials.secretAccessKey = "";
    },
    (value) => {
      value.receipt.state = "failed";
    },
    (value) => {
      value.receipt.databaseObject.key = "runs/another/database.age";
    },
    (value) => {
      value.erasureReceipts.push(value.erasureReceipts[0]);
    },
    (value) => {
      value.privateConfiguration = "not-permitted";
    },
  ]) {
    const value = structuredClone(kit);
    change(value);
    assert.throws(() => recoveryKit(value));
  }
});

test("the backup credential reader selects only the existing offsite key pair", async (t) => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "solarman-offsite-source-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const awsEnv = path.join(directory, "aws.env");
  await writeFile(
    awsEnv,
    "MINIO_ENDPOINT=s3.amazonaws.com\nMINIO_ROOT_USER=fixture-id\nMINIO_ROOT_PASSWORD=fixture-private\nUNRELATED_APPLICATION_PASSWORD=unrelated-private\n",
    { mode: 0o600 },
  );
  assert.deepEqual(await backupCredentials({ awsEnv }), {
    accessKeyId: "fixture-id",
    secretAccessKey: "fixture-private",
  });
});

test("recovery files are owner-only and cannot follow links or overwrite an earlier kit", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "solarman-private-kit-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "kit.age");
  await writePrivateRecoveryFile(file, Buffer.from("opaque-encrypted-fixture"));
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal(
    (await readPrivateRecoveryFile(file)).toString(),
    "opaque-encrypted-fixture",
  );
  await assert.rejects(
    writePrivateRecoveryFile(file, Buffer.from("replacement")),
    BackupError,
  );
  assert.equal((await readFile(file)).toString(), "opaque-encrypted-fixture");
  const linked = path.join(directory, "linked.age");
  await symlink(file, linked);
  await assert.rejects(readPrivateRecoveryFile(linked), BackupError);
  await chmod(file, 0o644);
  await assert.rejects(readPrivateRecoveryFile(file), BackupError);
  await assert.rejects(
    writePrivateRecoveryFile("relative.age", Buffer.from("data")),
    BackupError,
  );
  await assert.rejects(
    writePrivateRecoveryFile(
      path.join(directory, "empty.age"),
      Buffer.alloc(0),
    ),
    BackupError,
  );
  await chmod(directory, 0o755);
  await assert.rejects(
    writePrivateRecoveryFile(
      path.join(directory, "public.age"),
      Buffer.from("data"),
    ),
    BackupError,
  );
});

test(
  "direct offsite recovery authenticates all age objects and current erasures without restoring or returning secrets",
  { skip: !age },
  async (t) => {
    const fixture = await encryptedFixture(t);
    const report = await verifyRecoveryKit(fixture.encrypted, {
      age,
      identity: fixture.identity,
    });
    assert.equal(report.state, "verified");
    assert.equal(report.backupId, fixture.kit.receipt.id);
    assert.equal(report.retrieval, "direct_s3");
    assert.equal(report.postgresRestorePerformed, false);
    assert.equal(report.currentErasureReceipts, 1);
    assert.equal(report.databaseBytes, fixture.dump.length);
    const encoded = JSON.stringify(report);
    for (const secret of [
      fixture.kit.credentials.accessKeyId,
      fixture.kit.credentials.secretAccessKey,
      "provider-private-fixture",
      fixture.kit.location.recipient,
    ])
      assert.ok(!encoded.includes(secret));
    assert.equal(
      fixture.calls.filter((call) => call.name === "GetObjectCommand").length,
      4,
    );
    assert.ok(
      fixture.calls.every(
        (call) =>
          call.name.startsWith("Get") || call.name === "ListObjectsV2Command",
      ),
    );
  },
);

test(
  "direct recovery rejects substituted ciphertext and versions before accepting a checkpoint",
  { skip: !age },
  async (t) => {
    const fixture = await encryptedFixture(t);
    fixture.tamper = true;
    await assert.rejects(
      verifyRecoveryKit(fixture.encrypted, { age, identity: fixture.identity }),
      /recovery_object_checksum_mismatch/,
    );
    fixture.tamper = false;
    fixture.wrongVersion = true;
    await assert.rejects(
      verifyRecoveryKit(fixture.encrypted, { age, identity: fixture.identity }),
      /recovery_object_metadata_mismatch/,
    );
  },
);

test(
  "recovery cannot omit known erasures or loop through a repeated listing token",
  { skip: !age },
  async (t) => {
    const fixture = await encryptedFixture(t);
    fixture.current.clear();
    await assert.rejects(
      verifyRecoveryKit(fixture.encrypted, { age, identity: fixture.identity }),
      /recovery_erasure_baseline_missing/,
    );
    fixture.repeatToken = true;
    await assert.rejects(
      verifyRecoveryKit(fixture.encrypted, { age, identity: fixture.identity }),
      /recovery_erasure_listing_invalid/,
    );
  },
);

test(
  "a kit can use an explicit same-location checkpoint but refuses another bucket before any request",
  { skip: !age },
  async (t) => {
    const fixture = await encryptedFixture(t);
    const checkpoint = {
      version: 1,
      location: fixture.kit.location,
      receipt: fixture.kit.receipt,
    };
    const report = await verifyRecoveryKit(fixture.encrypted, {
      age,
      identity: fixture.identity,
      checkpoint,
    });
    assert.equal(report.backupId, fixture.kit.receipt.id);
    fixture.calls.length = 0;
    checkpoint.location = {
      ...checkpoint.location,
      bucket: "jilanov-solarman-backups-deadbeef",
    };
    await assert.rejects(
      verifyRecoveryKit(fixture.encrypted, {
        age,
        identity: fixture.identity,
        checkpoint,
      }),
      /recovery_checkpoint_location_mismatch/,
    );
    assert.equal(fixture.calls.length, 0);
  },
);

test(
  "oversized references and unauthenticated age input fail before an object is downloaded",
  { skip: !age },
  async (t) => {
    const fixture = await encryptedFixture(t);
    fixture.kit.receipt.manifestObject.bytes = 2 * 1024 * 1024;
    const oversized = await encryptRecoveryKit(fixture.kit, age);
    await assert.rejects(
      verifyRecoveryKit(oversized, { age, identity: fixture.identity }),
      /recovery_object_too_large/,
    );
    assert.equal(
      fixture.calls.filter((call) => call.name === "GetObjectCommand").length,
      0,
    );
    fixture.calls.length = 0;
    await assert.rejects(
      verifyRecoveryKit(
        fixture.encrypted.subarray(0, fixture.encrypted.length - 20),
        { age, identity: fixture.identity },
      ),
      BackupError,
    );
    assert.equal(fixture.calls.length, 0);
  },
);

test("the recovery CLI reports only fixed codes for invalid arguments and inaccessible private files", async () => {
  const file = path.join(
    tmpdir(),
    "private-argument-marker-" + randomUUID() + ".age",
  );
  for (const args of [
    ["verify", file],
    ["invalid-private-argument", file],
  ]) {
    const result = await new Promise((resolve) => {
      execFile(
        process.execPath,
        ["scripts/recovery-kit.mjs", ...args],
        { timeout: 30000 },
        (error, stdout, stderr) => resolve({ error, stdout, stderr }),
      );
    });
    assert.equal(result.error?.code, 1);
    assert.equal(result.stdout, "");
    assert.ok(!result.stderr.includes("private-argument"));
    const report = JSON.parse(result.stderr);
    assert.equal(report.state, "failed");
    assert.ok(
      ["recovery_file_unavailable", "recovery_kit_arguments_invalid"].includes(
        report.code,
      ),
    );
  }
});

test(
  "offsite credential failures never include provider diagnostics",
  { skip: !age },
  async (t) => {
    const fixture = await encryptedFixture(t);
    t.mock.method(S3Client.prototype, "send", async () => {
      throw Object.assign(new Error("private-credential-diagnostic"), {
        $metadata: { httpStatusCode: 403 },
      });
    });
    await assert.rejects(
      verifyRecoveryKit(fixture.encrypted, { age, identity: fixture.identity }),
      (error) =>
        error instanceof BackupError &&
        error.code === "recovery_offsite_access_denied" &&
        !error.message.includes("private-credential"),
    );
  },
);

test(
  "a changed known erasure cannot be accepted even with valid storage checksums",
  { skip: !age },
  async (t) => {
    const fixture = await encryptedFixture(t);
    const original = fixture.kit.erasureReceipts[0];
    fixture.current.set(original.id, { ...original, tenantId: randomUUID() });
    await assert.rejects(
      verifyRecoveryKit(fixture.encrypted, { age, identity: fixture.identity }),
      /recovery_erasure_baseline_missing/,
    );
  },
);
