import { readFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import {
  backupClient,
  configureBucket,
  receipt,
  runBackup,
  updateStatus,
  verifyBucket,
} from "../src/backup.mjs";
import {
  BackupError,
  boundedBuffer,
  MAX_RESTORE_BYTES,
  sealedConfig,
  UUID,
} from "../src/backup-io.mjs";
import { restoreDrill } from "../src/restore-drill.mjs";

async function main() {
  const [action, id, kind] = process.argv.slice(2);
  if (
    ![
      "configure",
      "run",
      "latest",
      "receipt",
      "export",
      "receive-drill",
      "failed-drill",
      "recovery-info",
      "check",
    ].includes(action)
  )
    throw new BackupError("action_invalid");
  const config = await sealedConfig("/etc/solarman-backup/config.json");
  if (action === "recovery-info") {
    const recipient = (await readFile(config.recipientFile, "utf8")).trim();
    if (!/^ssh-ed25519 [A-Za-z0-9+/]+=*$/.test(recipient))
      throw new BackupError("recovery_recipient_invalid");
    console.log(
      JSON.stringify({
        bucket: config.bucket,
        region: config.region,
        recipient,
      }),
    );
    return;
  }
  if (action === "receive-drill") {
    const bytes = await boundedBuffer(process.stdin, MAX_RESTORE_BYTES + 65536);
    const end = bytes.indexOf(10);
    if (end < 1 || end > 65535) throw new BackupError("drill_header_invalid");
    const header = JSON.parse(bytes.subarray(0, end).toString("utf8"));
    await receipt(config, header.backupId);
    await updateStatus(config, {
      restore: {
        state: "running",
        backupId: header.backupId,
        startedAt: new Date().toISOString(),
      },
    });
    const result = await restoreDrill(header, bytes.subarray(end + 1));
    await updateStatus(config, {
      restore: result,
      ...(result.state === "verified"
        ? { lastRestoreAt: result.completedAt }
        : {}),
    });
    console.log(JSON.stringify(result));
    if (result.state !== "verified") process.exitCode = 1;
    return;
  }
  if (action === "failed-drill") {
    if (!UUID.test(id)) throw new BackupError("run_id_invalid");
    await receipt(config, id);
    const startedAt = Number(kind);
    if (!Number.isSafeInteger(startedAt) || startedAt <= 0)
      throw new BackupError("drill_start_invalid");
    const status = JSON.parse(
      await readFile(config.stateDirectory + "/public/status.json", "utf8"),
    );
    // Preserve the receiver's more specific result for this attempt.
    if (
      status.restore?.backupId === id &&
      Date.parse(status.restore.completedAt) >= startedAt - 1000
    ) {
      console.log(JSON.stringify({ state: "recorded" }));
      return;
    }
    await updateStatus(config, {
      restore: {
        state: "failed",
        backupId: id,
        completedAt: new Date().toISOString(),
        code: "offserver_verification_failed",
      },
    });
    console.log(JSON.stringify({ state: "recorded" }));
    return;
  }
  if (action === "latest") {
    const value = JSON.parse(
      await readFile(config.stateDirectory + "/latest.json", "utf8"),
    );
    console.log(JSON.stringify({ id: value.id }));
    return;
  }
  if (action === "receipt") {
    console.log(JSON.stringify(await receipt(config, id)));
    return;
  }
  const client = await backupClient(config);
  try {
    if (action === "check") {
      await verifyBucket(client, config);
      console.log(JSON.stringify({ state: "verified" }));
    }
    if (action === "configure") {
      await configureBucket(client, config);
      console.log(JSON.stringify({ state: "configured" }));
    }
    if (action === "run") {
      const result = await runBackup(client, config);
      console.log(JSON.stringify({ id: result.id, state: result.state }));
    }
    if (action === "export") {
      if (!["database", "configuration", "manifest"].includes(kind))
        throw new BackupError("object_kind_invalid");
      const run = await receipt(config, id);
      const object = run[`${kind}Object`];
      const response = await client.send(
        new GetObjectCommand({
          Bucket: config.bucket,
          Key: object.key,
          VersionId: object.versionId,
        }),
      );
      await pipeline(response.Body, process.stdout);
    }
  } finally {
    client.destroy();
  }
}

main().catch((error) => {
  console.error(
    JSON.stringify({
      state: "failed",
      code:
        error instanceof BackupError ? error.code : "backup_operation_failed",
    }),
  );
  process.exitCode = 1;
});
