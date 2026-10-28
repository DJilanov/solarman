import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, chmod, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  readBackupStatus,
  summarizeBackupStatus,
} from "../src/backup-status.mjs";

const now = Date.parse("2026-10-28T12:00:00Z");
function receipt() {
  const completedAt = new Date(now - 3600_000).toISOString();
  return {
    version: 1,
    retentionDays: 30,
    lastBackupAt: completedAt,
    lastRestoreAt: completedAt,
    backup: { state: "verified", completedAt, offsiteVerified: true },
    restore: {
      state: "verified",
      completedAt,
      inventoryVerified: true,
      credentialsVerified: true,
      authenticationVerified: true,
      controlQuarantined: true,
      deviceAccessAttempts: 0,
    },
  };
}

test("recovery health requires real verification flags and separates recent success from a failed attempt", () => {
  assert.equal(summarizeBackupStatus(receipt(), now).state, "healthy");
  for (const patch of [
    { backup: { ...receipt().backup, offsiteVerified: false } },
    { restore: { ...receipt().restore, deviceAccessAttempts: 1 } },
    { restore: { ...receipt().restore, authenticationVerified: false } },
    { lastRestoreAt: new Date(now - 30_000).toISOString() },
    { lastBackupAt: new Date(now + 120_000).toISOString() },
    { backup: null },
  ])
    assert.throws(() => summarizeBackupStatus({ ...receipt(), ...patch }, now));
  const failed = summarizeBackupStatus(
    {
      ...receipt(),
      restore: {
        state: "failed",
        completedAt: new Date(now).toISOString(),
      },
    },
    now,
  );
  assert.equal(failed.state, "attention");
  assert.deepEqual(failed.issues, ["restore_failed"]);
  assert.equal(failed.lastRestoreAt, receipt().lastRestoreAt);
  assert.equal(failed.restore.authenticationVerified, false);
});

test("backup and recovery age, missing evidence and stalled attempts cannot report healthy", () => {
  const status = summarizeBackupStatus(receipt(), now + 9 * 86400_000);
  assert.deepEqual(status.issues, ["backup_overdue", "restore_overdue"]);
  assert.equal(status.state, "attention");
  const running = {
    ...receipt(),
    backup: { state: "running", startedAt: new Date(now).toISOString() },
  };
  assert.equal(summarizeBackupStatus(running, now).state, "running");
  assert.deepEqual(summarizeBackupStatus(running, now + 36 * 60_000).issues, [
    "backup_stalled",
  ]);
  assert.deepEqual(
    summarizeBackupStatus({ version: 1, retentionDays: 30 }, now).issues,
    ["backup_missing", "restore_missing"],
  );
});

test("status reading rejects links, unsafe permissions, malformed data and oversized files without returning their contents", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "solarman-status-"));
  const file = path.join(directory, "status.json");
  const read = (target = file) =>
    readBackupStatus(target, { now, requireRoot: false });
  try {
    assert.deepEqual(await read(), { state: "not-configured" });
    await writeFile(
      file,
      JSON.stringify({ ...receipt(), secret: "never-expose" }),
      { mode: 0o600 },
    );
    const good = await read();
    assert.equal(good.state, "healthy");
    assert.equal(JSON.stringify(good).includes("never-expose"), false);
    if (process.getuid() !== 0)
      assert.deepEqual(
        await readBackupStatus(file, { now, requireRoot: true }),
        { state: "unavailable" },
      );
    await symlink(file, path.join(directory, "link.json"));
    assert.deepEqual(await read(path.join(directory, "link.json")), {
      state: "unavailable",
    });
    await chmod(file, 0o666);
    assert.deepEqual(await read(), { state: "unavailable" });
    await chmod(file, 0o600);
    await writeFile(file, "private-error-marker");
    assert.deepEqual(await read(), { state: "unavailable" });
    await writeFile(file, "x".repeat(65537));
    assert.deepEqual(await read(), { state: "unavailable" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
