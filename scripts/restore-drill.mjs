import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import {
  BackupError,
  MAX_RESTORE_BYTES,
  runBuffered,
  UUID,
  atomicJson,
} from "../src/backup-io.mjs";
import { validateObject } from "../src/backup.mjs";
import { encryptionKey } from "../src/credentials.mjs";

/** @param {string} value @returns {string} */
function quote(value) {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

async function main() {
  let env = {};
  try {
    env = parseEnv(await readFile(".env", "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const target =
    process.env.BACKUP_SSH_TARGET ??
    env.BACKUP_SSH_TARGET ??
    "root@92.247.242.86";
  if (!/^[a-z][a-z0-9_-]*@[a-z0-9][a-z0-9.-]+$/.test(target))
    throw new BackupError("ssh_target_invalid");
  const age =
    process.env.BACKUP_AGE_BINARY ??
    env.BACKUP_AGE_BINARY ??
    path.join(homedir(), ".local/share/solarman-tools/age-v1.3.2/age");
  const identity =
    process.env.BACKUP_RECOVERY_IDENTITY ??
    env.BACKUP_RECOVERY_IDENTITY ??
    path.join(homedir(), ".ssh/id_ed25519");
  const script =
    process.env.BACKUP_REMOTE_SCRIPT ??
    env.BACKUP_REMOTE_SCRIPT ??
    "/opt/solarman-ops/current/scripts/backup.mjs";
  if (!path.isAbsolute(script)) throw new BackupError("remote_script_invalid");
  const remote = async (args, input = Buffer.alloc(0), maximum = 1024 * 1024) =>
    runBuffered(
      "ssh",
      [
        "-T",
        "-o",
        "BatchMode=yes",
        target,
        ["/opt/jilanov-node/node-v24.22.1-linux-x64/bin/node", script, ...args]
          .map(quote)
          .join(" "),
      ],
      input,
      { maximum, allowedExitCodes: args[0] === "receive-drill" ? [0, 1] : [0] },
    );
  let id;
  const startedAt = Date.now();
  let stage = "receipt_download";
  try {
    id =
      process.argv[2] ??
      JSON.parse((await remote(["latest"])).toString("utf8")).id;
    if (!UUID.test(id)) throw new BackupError("run_id_invalid");
    const receipt = JSON.parse(
      (await remote(["receipt", id])).toString("utf8"),
    );
    if (receipt.id !== id || receipt.state !== "verified")
      throw new BackupError("receipt_invalid");
    const decrypt = async (kind, object, maximum) => {
      stage = `${kind}_download`;
      validateObject(object, id, kind);
      if (object.bytes > maximum + 65536)
        throw new BackupError("payload_too_large");
      const encrypted = await remote(
        ["export", id, kind],
        Buffer.alloc(0),
        maximum + 65536,
      );
      if (
        encrypted.length !== object.bytes ||
        createHash("sha256").update(encrypted).digest("hex") !== object.sha256
      )
        throw new BackupError("offsite_checksum_mismatch");
      stage = `${kind}_decryption`;
      return await runBuffered(
        age,
        ["--decrypt", "--identity", identity],
        encrypted,
        { maximum },
      );
    };
    const manifest = JSON.parse(
      (await decrypt("manifest", receipt.manifestObject, 1024 * 1024)).toString(
        "utf8",
      ),
    );
    if (
      manifest.version !== 1 ||
      manifest.id !== id ||
      manifest.database !== "solarman" ||
      !Number.isSafeInteger(manifest.plainBytes) ||
      manifest.plainBytes > MAX_RESTORE_BYTES
    )
      throw new BackupError("manifest_invalid");
    assert.deepEqual(manifest.databaseObject, receipt.databaseObject);
    assert.deepEqual(manifest.configurationObject, receipt.configurationObject);
    const configuration = parseEnv(
      (
        await decrypt("configuration", manifest.configurationObject, 65536)
      ).toString("utf8"),
    );
    encryptionKey(configuration.CREDENTIAL_ENCRYPTION_KEY);
    const dump = await decrypt(
      "database",
      manifest.databaseObject,
      MAX_RESTORE_BYTES,
    );
    if (dump.length !== manifest.plainBytes)
      throw new BackupError("plaintext_size_mismatch");
    const header = {
      version: 1,
      backupId: id,
      database: "solarman",
      plainBytes: dump.length,
      plainSha256: createHash("sha256").update(dump).digest("hex"),
      contents: manifest.contents,
      accountCount: manifest.accountCount,
      credentialKey: configuration.CREDENTIAL_ENCRYPTION_KEY,
    };
    const input = Buffer.concat([
      Buffer.from(JSON.stringify(header) + "\n"),
      dump,
    ]);
    stage = "sandbox_restore";
    const report = JSON.parse(
      (await remote(["receive-drill"], input)).toString("utf8"),
    );
    if (
      report.state !== "verified" ||
      report.inventoryVerified !== true ||
      report.authenticationVerified !== true ||
      report.accountSecurityVerified !== true ||
      report.accountRecoveryVerified !== true ||
      report.tenantLifecycleVerified !== true ||
      report.retentionQuarantined !== true ||
      report.workspaceExportVerified !== true ||
      report.recoveryQuarantined !== true ||
      report.schemaUpgradeVerified !== true ||
      report.credentialsVerified !== true ||
      report.controlQuarantined !== true ||
      !Array.isArray(report.migrationsApplied) ||
      report.deviceAccessAttempts !== 0
    )
      throw new BackupError(
        [
          "sandbox_creation",
          "database_restore",
          "inventory_validation",
          "schema_upgrade",
          "quarantine",
          "authentication",
          "database_cleanup_failed",
          "role_cleanup_failed",
        ].includes(report.code)
          ? `restore_${report.code}`
          : "restore_drill_failed",
      );
    stage = "recovery_pack";
    const location = JSON.parse(
      (await remote(["recovery-info"])).toString("utf8"),
    );
    if (
      !/^jilanov-solarman-backups-[a-f0-9]{8}$/.test(location.bucket) ||
      !/^[a-z]{2}-[a-z]+-\d$/.test(location.region) ||
      !/^ssh-ed25519 [A-Za-z0-9+/]+=*$/.test(location.recipient)
    )
      throw new BackupError("recovery_location_invalid");
    await atomicJson(
      path.join(homedir(), ".local/share/solarman-backup/recovery-pack.json"),
      {
        version: 1,
        location,
        receipt,
        restore: report,
      },
    );
    console.log(JSON.stringify(report));
  } catch (error) {
    if (id && UUID.test(id))
      await remote(["failed-drill", id, String(startedAt)]).catch(() => {});
    throw error instanceof BackupError && error.code !== "process_failed"
      ? error
      : new BackupError(stage);
  }
}

main().catch((error) => {
  console.error(
    JSON.stringify({
      state: "failed",
      code: error instanceof BackupError ? error.code : "restore_drill_failed",
    }),
  );
  process.exitCode = 1;
});
