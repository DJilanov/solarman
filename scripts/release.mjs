import path from "node:path";

/** @param {string[]} applied @param {string[]} supported @returns {void} */
export function assertRollbackCompatibility(applied, supported) {
  if (
    applied.includes("024_energy_planning.sql") &&
    !supported.includes("024_energy_planning.sql")
  )
    throw new Error(
      "Rollback requires a release that supports energy planning storage; restore a pre-upgrade backup otherwise",
    );
  if (
    applied.includes("023_outage_preparation.sql") &&
    !supported.includes("023_outage_preparation.sql")
  )
    throw new Error(
      "Rollback requires a release that supports outage preparation storage; restore a pre-upgrade backup otherwise",
    );
  if (
    applied.includes("022_web_push.sql") &&
    !supported.includes("022_web_push.sql")
  )
    throw new Error(
      "Rollback requires a release that supports Web Push storage; use a compatible release or restore a pre-upgrade backup",
    );
}

/**
 * @param {{ directory: string, sha: string, index: string }} expected
 * @param {{ cwd: string, script: string, status: string, health: { status: string, release: string }, index: string }} running
 * @returns {void}
 */
export function verifyRelease(expected, running) {
  if (
    running.status !== "online" ||
    running.cwd !== expected.directory ||
    running.script !== path.join(expected.directory, "src/server.mjs")
  ) {
    throw new Error(
      "PM2 is not running the expected release directory and entry point",
    );
  }
  if (
    running.health.status !== "ok" ||
    running.health.release !== expected.sha
  ) {
    throw new Error("Application health does not match the expected release");
  }
  if (running.index !== expected.index)
    throw new Error("The served page does not match the built release");
}
