import { setTimeout as delay } from "node:timers/promises";
import { loadConfig } from "./config.mjs";
import { SolarmanClient } from "./solarman.mjs";
import { BatteryController } from "./controller.mjs";

/** @param {object} event @returns {void} */
function log(event) {
  console.log(JSON.stringify({ time: new Date().toISOString(), ...event }));
}

async function main() {
  const args = process.argv.slice(2);
  if (
    args.some((arg) => !["--once", "--disable"].includes(arg)) ||
    args.length > 1
  ) {
    throw new Error("Usage: node src/main.mjs [--once | --disable]");
  }
  const once = args.includes("--once");
  const disable = args.includes("--disable");
  const config = loadConfig(process.env);
  if (disable && !config.writesEnabled)
    throw new Error("The disable command requires WRITES_ENABLED=true");
  const writesEnabled = config.writesEnabled && !once;
  let stopping = false;
  let lastSuccess = null;
  let lastFailed = false;
  const waitAbort = new AbortController();
  const stop = () => {
    stopping = true;
    waitAbort.abort();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const client = new SolarmanClient(config, {
    health: () => ({
      healthy:
        !stopping &&
        !lastFailed &&
        lastSuccess !== null &&
        Date.now() - lastSuccess < config.pollMs + 180_000,
      mode: writesEnabled ? "live" : "dry-run",
      lastSuccessAt:
        lastSuccess === null ? null : new Date(lastSuccess).toISOString(),
    }),
  });
  const controller = new BatteryController(client, {
    ...config,
    writesEnabled,
    log,
    isStopping: () => stopping,
  });
  await client.listen(config.port, config.host);
  log({
    event: "started",
    mode: writesEnabled ? "live" : "dry-run",
    pollSeconds: config.pollMs / 1000,
  });
  try {
    if (disable) {
      await controller.disable();
      return;
    }
    while (!stopping) {
      try {
        await controller.tick();
        lastSuccess = Date.now();
        lastFailed = false;
      } catch (error) {
        lastFailed = true;
        log({
          event: "cycle_failed",
          message: error instanceof Error ? error.message : "Unknown error",
        });
        try {
          await controller.disable();
        } catch {
          log({
            event: "disable_failed",
            message:
              "Could not confirm AC charging is off; use the manual disable command if needed",
          });
        }
        if (once) {
          process.exitCode = 1;
          break;
        }
      }
      if (once || stopping) break;
      try {
        await delay(config.pollMs, undefined, { signal: waitAbort.signal });
      } catch (error) {
        if (!stopping) throw error;
      }
    }
  } finally {
    if (writesEnabled) {
      try {
        await controller.disable();
      } catch {
        process.exitCode = 1;
        log({
          event: "shutdown_disable_failed",
          message:
            "AC charging off could not be confirmed; the last short daily window may remain active",
        });
      }
    }
    await client.close();
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    log({ event: "stopped" });
  }
}

main().catch((error) => {
  log({
    event: "fatal",
    message: error instanceof Error ? error.message : "Unknown error",
  });
  process.exitCode = 1;
});
