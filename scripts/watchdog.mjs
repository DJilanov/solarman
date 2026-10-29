import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { readWatchdogConfig, WatchdogError } from "../src/watchdog-config.mjs";
import { watchdogDirectory } from "../src/watchdog-store.mjs";
import { probeHealth, probeOrigin } from "../src/watchdog-probes.mjs";
import { currentWatchdogStatus, runWatchdog } from "../src/watchdog.mjs";

/** @returns {Promise<void>} */
async function main() {
  const raw = process.argv.slice(2),
    locked = raw[0] === "--under-lock";
  const args = locked ? raw.slice(1) : raw;
  const testId = args[0] === "confirm-test" ? args[1] : undefined;
  const parsed = testId ? [args[0], ...args.slice(2)] : args;
  const [
    action,
    configFile = "/etc/solarman-watchdog/config.json",
    directory = "/var/lib/solarman-watchdog",
  ] = parsed;
  if (
    parsed.length > 3 ||
    (parsed[0] === "confirm-test" &&
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
        testId ?? "",
      )) ||
    ![
      "probe",
      "status",
      "run",
      "test",
      "new-test",
      "cancel-test",
      "quarantine",
      "confirm-test",
    ].includes(action) ||
    !path.isAbsolute(configFile) ||
    !path.isAbsolute(directory)
  )
    throw new WatchdogError("arguments_invalid");
  if (!["probe", "status"].includes(action) && !locked) {
    await watchdogDirectory(directory);
    const child = spawn(
      "/usr/bin/flock",
      [
        "--no-fork",
        "--nonblock",
        "--conflict-exit-code",
        "75",
        path.join(directory, "run.lock"),
        process.execPath,
        fileURLToPath(import.meta.url),
        "--under-lock",
        ...args,
      ],
      { stdio: "inherit", detached: true },
    );
    const forward = (signal) => {
      try {
        process.kill(-child.pid, signal);
      } catch {}
    };
    const stop = () => forward("SIGTERM"),
      interrupt = () => forward("SIGINT");
    process.on("SIGTERM", stop);
    process.on("SIGINT", interrupt);
    try {
      process.exitCode = await new Promise((resolve, reject) => {
        child.once("error", () =>
          reject(new WatchdogError("file_lock_unavailable")),
        );
        child.once("exit", (code) => resolve(code ?? 1));
      });
    } finally {
      process.off("SIGTERM", stop);
      process.off("SIGINT", interrupt);
    }
    return;
  }
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  try {
    if (action === "probe") {
      const config = await readWatchdogConfig(configFile);
      const [health, origin] = await Promise.all([
        probeHealth(config.url, { signal: abort.signal }),
        probeOrigin(config.originHost, config.originPort, {
          signal: abort.signal,
        }),
      ]);
      console.log(
        JSON.stringify({ at: new Date().toISOString(), ...health, origin }),
      );
      if (!health.healthy) process.exitCode = 1;
    } else if (action === "status")
      console.log(
        JSON.stringify(await currentWatchdogStatus(configFile, directory)),
      );
    else
      console.log(
        JSON.stringify(
          await runWatchdog(configFile, directory, {
            action,
            testId,
            signal: abort.signal,
          }),
        ),
      );
  } finally {
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
  }
}

main().catch((error) => {
  console.error(
    JSON.stringify({
      state: "failed",
      code:
        error instanceof WatchdogError
          ? error.code
          : "watchdog_operation_failed",
    }),
  );
  process.exitCode = 1;
});
