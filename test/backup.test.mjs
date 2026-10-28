import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  boundedBuffer,
  BackupError,
  identifier,
  runBuffered,
} from "../src/backup-io.mjs";
import { validateObject, verifyBucket } from "../src/backup.mjs";
import { validateDrill } from "../src/restore-drill.mjs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

test("restore inputs must bind exact database bytes, source database and inventory", () => {
  const bytes = Buffer.from("test archive");
  const header = {
    version: 1,
    backupId: randomUUID(),
    database: "solarman",
    plainBytes: bytes.length,
    plainSha256: createHash("sha256").update(bytes).digest("hex"),
    contents: {
      counts: { users: 1 },
      migrations: ["001_dashboard.sql"],
      authHash: "a".repeat(64),
    },
    accountCount: 1,
    credentialKey: Buffer.alloc(32, 3).toString("base64"),
  };
  assert.doesNotThrow(() => validateDrill(header, bytes));
  for (const patch of [
    { database: "postgres" },
    { backupId: "../../postgres" },
    { plainBytes: 1 },
    { accountCount: -1 },
    { contents: { ...header.contents, counts: [] } },
    { contents: { ...header.contents, counts: { users: -1 } } },
  ])
    assert.throws(() => validateDrill({ ...header, ...patch }, bytes));
  assert.throws(() => validateDrill(header, Buffer.from("corrupted archive")));
});

test("backup references cannot escape their run or substitute an unverified object version", () => {
  const id = randomUUID();
  const object = {
    key: `runs/${id}/database.age`,
    versionId: "version-1",
    bytes: 500,
    sha256: "b".repeat(64),
  };
  assert.doesNotThrow(() => validateObject(object, id, "database"));
  for (const patch of [
    { key: "../another-run/database.age" },
    { key: `runs/${randomUUID()}/database.age` },
    { versionId: "" },
    { bytes: -1 },
    { sha256: "invalid" },
  ])
    assert.throws(
      () => validateObject({ ...object, ...patch }, id, "database"),
      BackupError,
    );
  assert.equal(
    identifier('a";DROP TABLE users;--'),
    '"a"";DROP TABLE users;--"',
  );
});

test("buffer limits fail closed and child diagnostics never become credential-bearing errors", async () => {
  assert.equal(
    (await boundedBuffer([Buffer.from("safe")], 4)).toString(),
    "safe",
  );
  await assert.rejects(
    boundedBuffer([Buffer.alloc(5)], 4),
    /payload_too_large/,
  );
  const output = await runBuffered(
    process.execPath,
    ["-e", "process.stdin.pipe(process.stdout)"],
    Buffer.from("bounded output"),
  );
  assert.equal(output.toString(), "bounded output");
  await assert.rejects(
    runBuffered(
      process.execPath,
      ["-e", "process.stderr.write('private-error-marker');process.exit(1)"],
      Buffer.alloc(0),
    ),
    (error) =>
      error instanceof BackupError &&
      !error.message.includes("private-error-marker"),
  );
  const failureReport = await runBuffered(
    process.execPath,
    ["-e", 'process.stdout.write(\'{"state":"failed"}\');process.exitCode=1'],
    Buffer.alloc(0),
    { allowedExitCodes: [0, 1] },
  );
  assert.deepEqual(JSON.parse(failureReport.toString()), { state: "failed" });
  await assert.rejects(
    runBuffered(
      process.execPath,
      [
        "-e",
        "process.stdout.write('unauthenticated-plaintext');process.exitCode=1",
      ],
      Buffer.alloc(0),
    ),
    /process_failed/,
  );
});

test("offsite verification requires public access blocking, encryption, versioning and the retention policy", async () => {
  const responses = {
    GetPublicAccessBlockCommand: {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        IgnorePublicAcls: true,
        BlockPublicPolicy: true,
        RestrictPublicBuckets: true,
      },
    },
    GetBucketEncryptionCommand: {
      ServerSideEncryptionConfiguration: {
        Rules: [
          { ApplyServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } },
        ],
      },
    },
    GetBucketVersioningCommand: { Status: "Enabled" },
    GetBucketLifecycleConfigurationCommand: {
      Rules: [
        {
          Status: "Enabled",
          Filter: { Prefix: "runs/" },
          Expiration: { Days: 30 },
          NoncurrentVersionExpiration: { NoncurrentDays: 30 },
        },
      ],
    },
  };
  const client = {
    send: async (command) => responses[command.constructor.name],
  };
  await verifyBucket(client, { bucket: "fixture-bucket" });
  responses.GetPublicAccessBlockCommand.PublicAccessBlockConfiguration.BlockPublicPolicy = false;
  await assert.rejects(
    verifyBucket(client, { bucket: "fixture-bucket" }),
    /offsite_protection_invalid/,
  );
  responses.GetPublicAccessBlockCommand.PublicAccessBlockConfiguration.BlockPublicPolicy = true;
  responses.GetBucketLifecycleConfigurationCommand.Rules[0].Expiration.Days = 1;
  await assert.rejects(
    verifyBucket(client, { bucket: "fixture-bucket" }),
    /offsite_protection_invalid/,
  );
});

test(
  "concurrent backup and restore status writers preserve each other's receipts",
  { skip: process.platform !== "linux" },
  async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "solarman-backup-lock-"),
    );
    try {
      const source = `import {updateStatus} from ${JSON.stringify(new URL("../src/backup.mjs", import.meta.url).href)};
      await updateStatus({stateDirectory:process.argv[1]},JSON.parse(process.argv[2]));`;
      await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          runBuffered(
            process.execPath,
            [
              "--input-type=module",
              "-e",
              source,
              directory,
              JSON.stringify({ ["writer" + index]: true }),
            ],
            Buffer.alloc(0),
          ),
        ),
      );
      const status = JSON.parse(
        await readFile(path.join(directory, "public/status.json"), "utf8"),
      );
      for (let index = 0; index < 8; index++)
        assert.equal(status["writer" + index], true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
