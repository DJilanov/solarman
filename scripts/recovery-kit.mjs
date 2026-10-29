import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { BackupError, runBuffered } from "../src/backup-io.mjs";
import {
  MAX_RECOVERY_KIT_BYTES,
  readPrivateRecoveryFile,
  verifyRecoveryKit,
  writePrivateRecoveryFile,
} from "../src/recovery-kit.mjs";

/** @param {string} value @returns {string} */
function quote(value) {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

/** @returns {Promise<void>} */
async function main() {
  const [action, file, checkpointFile, ...extra] = process.argv.slice(2);
  if (
    !["export", "verify"].includes(action) ||
    !file ||
    !path.isAbsolute(file) ||
    extra.length ||
    (action === "export" && checkpointFile !== undefined)
  )
    throw new BackupError("recovery_kit_arguments_invalid");
  const age =
    process.env.BACKUP_AGE_BINARY ??
    path.join(homedir(), ".local/share/solarman-tools/age-v1.3.2/age");
  const identity =
    process.env.BACKUP_RECOVERY_IDENTITY ??
    path.join(homedir(), ".ssh/id_ed25519");
  if (!path.isAbsolute(age) || !path.isAbsolute(identity))
    throw new BackupError("recovery_tool_path_invalid");
  let encrypted;
  let checkpoint;
  if (action === "export") {
    const target = process.env.BACKUP_SSH_TARGET ?? "root@92.247.242.86";
    const script =
      process.env.BACKUP_REMOTE_SCRIPT ??
      "/opt/solarman-ops/current/scripts/backup.mjs";
    if (
      !/^[a-z][a-z0-9_-]*@[a-z0-9][a-z0-9.-]+$/.test(target) ||
      !path.isAbsolute(script)
    )
      throw new BackupError("recovery_export_target_invalid");
    encrypted = await runBuffered(
      "ssh",
      [
        "-T",
        "-o",
        "BatchMode=yes",
        target,
        [
          "/opt/jilanov-node/node-v24.22.1-linux-x64/bin/node",
          script,
          "recovery-kit",
        ]
          .map(quote)
          .join(" "),
      ],
      Buffer.alloc(0),
      { maximum: MAX_RECOVERY_KIT_BYTES + 65536 },
    );
  } else {
    encrypted = await readPrivateRecoveryFile(file);
    if (checkpointFile !== undefined)
      checkpoint = JSON.parse(
        (await readPrivateRecoveryFile(checkpointFile, 1024 * 1024)).toString(
          "utf8",
        ),
      );
  }
  const report = await verifyRecoveryKit(encrypted, {
    age,
    identity,
    checkpoint,
  });
  if (action === "export") await writePrivateRecoveryFile(file, encrypted);
  console.log(
    JSON.stringify({
      ...report,
      kitFile: file,
      kitBytes: encrypted.length,
      kitSha256: createHash("sha256").update(encrypted).digest("hex"),
    }),
  );
}

main().catch((error) => {
  console.error(
    JSON.stringify({
      state: "failed",
      code:
        error instanceof BackupError
          ? error.code
          : "recovery_kit_operation_failed",
    }),
  );
  process.exitCode = 1;
});
