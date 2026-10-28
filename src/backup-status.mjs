import { open, constants } from "node:fs/promises";

const DAY_MS = 86400_000;
const STATES = new Set(["running", "verified", "failed"]);

/** @param {unknown} value @param {number} now @returns {string | null} */
function timestamp(value, now) {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    Date.parse(value) > now + 60_000
  )
    throw new Error("invalid_backup_timestamp");
  return new Date(value).toISOString();
}

/** @param {unknown} value @param {number} now @returns {object} */
export function summarizeBackupStatus(value, now = Date.now()) {
  if (
    !value ||
    typeof value !== "object" ||
    value.version !== 1 ||
    value.retentionDays !== 30
  )
    throw new Error("invalid_backup_status");
  const { backup, restore } = value;
  for (const attempt of [backup, restore]) {
    if (
      attempt &&
      (!STATES.has(attempt.state) ||
        (attempt.state === "running"
          ? !attempt.startedAt
          : !attempt.completedAt))
    )
      throw new Error("invalid_backup_attempt");
  }
  const lastBackupAt = timestamp(value.lastBackupAt, now);
  const lastRestoreAt = timestamp(value.lastRestoreAt, now);
  if ((lastBackupAt && !backup) || (lastRestoreAt && !restore))
    throw new Error("missing_backup_attempt");
  const backupStartedAt = timestamp(backup?.startedAt, now);
  const restoreStartedAt = timestamp(restore?.startedAt, now);
  const backupCompletedAt = timestamp(backup?.completedAt, now);
  const restoreCompletedAt = timestamp(restore?.completedAt, now);
  const offsiteVerified =
    backup?.state === "verified" && backup.offsiteVerified === true;
  const restoreVerified =
    restore?.state === "verified" &&
    restore.inventoryVerified === true &&
    restore.credentialsVerified === true &&
    restore.authenticationVerified === true &&
    restore.controlQuarantined === true &&
    restore.deviceAccessAttempts === 0;
  if (
    (backup?.state === "verified" &&
      (!offsiteVerified ||
        !lastBackupAt ||
        backupCompletedAt !== lastBackupAt)) ||
    (restore?.state === "verified" &&
      (!restoreVerified ||
        !lastRestoreAt ||
        restoreCompletedAt !== lastRestoreAt))
  )
    throw new Error("unverified_backup_receipt");
  const issues = [];
  if (backup?.state === "failed") issues.push("backup_failed");
  if (restore?.state === "failed") issues.push("restore_failed");
  if (!lastBackupAt && backup?.state !== "running")
    issues.push("backup_missing");
  else if (lastBackupAt && now - Date.parse(lastBackupAt) > 26 * 3600_000)
    issues.push("backup_overdue");
  if (!lastRestoreAt && restore?.state !== "running")
    issues.push("restore_missing");
  else if (lastRestoreAt && now - Date.parse(lastRestoreAt) > 8 * DAY_MS)
    issues.push("restore_overdue");
  for (const [name, attempt, startedAt] of [
    ["backup", backup, backupStartedAt],
    ["restore", restore, restoreStartedAt],
  ])
    if (
      attempt?.state === "running" &&
      now - Date.parse(startedAt) > 35 * 60_000
    )
      issues.push(`${name}_stalled`);
  const running = backup?.state === "running" || restore?.state === "running";
  return {
    state: issues.length ? "attention" : running ? "running" : "healthy",
    issues,
    lastBackupAt,
    lastRestoreAt,
    retentionDays: 30,
    backup: {
      state: backup?.state ?? "never",
      startedAt: backupStartedAt,
      completedAt: backupCompletedAt,
      offsiteVerified,
    },
    restore: {
      state: restore?.state ?? "never",
      startedAt: restoreStartedAt,
      completedAt: restoreCompletedAt,
      inventoryVerified: restoreVerified,
      credentialsVerified: restoreVerified,
      authenticationVerified: restoreVerified,
      controlQuarantined: restoreVerified,
    },
  };
}

/** @param {string} file @param {{now?:number,requireRoot?:boolean}} [options] @returns {Promise<object>} */
export async function readBackupStatus(
  file = "/var/lib/solarman-backup/public/status.json",
  {
    now = Date.now(),
    requireRoot = process.env.NODE_ENV === "production",
  } = {},
) {
  let handle;
  try {
    handle = await open(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const info = await handle.stat();
    if (
      !info.isFile() ||
      info.size > 65536 ||
      (info.mode & 0o022) !== 0 ||
      (requireRoot && info.uid !== 0)
    )
      throw new Error("untrusted_backup_status");
    return summarizeBackupStatus(
      JSON.parse(await handle.readFile("utf8")),
      now,
    );
  } catch (error) {
    return {
      state: error.code === "ENOENT" ? "not-configured" : "unavailable",
    };
  } finally {
    await handle?.close();
  }
}
