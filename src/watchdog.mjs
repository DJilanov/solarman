import {
  readWatchdogConfig,
  watchdogBindings,
  WatchdogError,
} from "./watchdog-config.mjs";
import { readWatchdogState, writeWatchdogState } from "./watchdog-store.mjs";
import { probeHealth, probeOrigin } from "./watchdog-probes.mjs";
import { sendTelegram } from "./telegram.mjs";
import { sendWebPush } from "./web-push.mjs";
import { probeWatchdogPermission } from "./watchdog-permission.mjs";
import {
  reconcileWatchdog,
  recoverWatchdog,
  observeWatchdog,
  requestWatchdogTest,
  cancelWatchdogTest,
  quarantineWatchdog,
  dueWatchdog,
  beginWatchdogDelivery,
  completeWatchdogDelivery,
  pruneWatchdog,
  watchdogDeliveryEnabled,
  watchdogStatus,
  updateWatchdogPermission,
  confirmWatchdogPushTest,
} from "./watchdog-state.mjs";

/** @param {string} configFile @param {string} directory @param {{action?:'run'|'test'|'new-test'|'cancel-test'|'quarantine'|'confirm-test',testId?:string,healthProbe?:typeof probeHealth,originProbe?:typeof probeOrigin,permissionProbe?:typeof probeWatchdogPermission,sendPush?:typeof sendWebPush,send?:typeof sendTelegram,clock?:()=>number,persist?:typeof writeWatchdogState,signal?:AbortSignal}} [options] @returns {Promise<object>} */
export async function runWatchdog(
  configFile,
  directory,
  {
    action = "run",
    healthProbe = probeHealth,
    originProbe = probeOrigin,
    send = sendTelegram,
    sendPush = sendWebPush,
    permissionProbe = probeWatchdogPermission,
    testId,
    clock = Date.now,
    persist = writeWatchdogState,
    signal,
  } = {},
) {
  if (
    ![
      "run",
      "test",
      "new-test",
      "cancel-test",
      "quarantine",
      "confirm-test",
    ].includes(action)
  )
    throw new WatchdogError("action_invalid");
  if (signal?.aborted) throw new WatchdogError("operation_cancelled");
  let config = await readWatchdogConfig(configFile);
  const state = await readWatchdogState(directory);
  if (state.lastSample && clock() < Date.parse(state.lastSample.at))
    throw new WatchdogError("clock_regressed");
  reconcileWatchdog(state, config, clock());
  recoverWatchdog(state, clock());
  let permission = null;
  const permissionCheck = () =>
    config.delivery?.kind === "webpush"
      ? permissionProbe(config.delivery.permission, { signal })
      : Promise.resolve(null);
  let onlyId = null;
  if (action === "run") {
    const [health, origin, allowed] = await Promise.all([
      healthProbe(config.url, { signal }),
      originProbe(config.originHost, config.originPort, { signal }),
      permissionCheck(),
    ]);
    if (signal?.aborted) throw new WatchdogError("operation_cancelled");
    permission = allowed;
    if (permission)
      updateWatchdogPermission(state, config, permission, clock());
    observeWatchdog(state, config, {
      healthy: health.healthy,
      code: health.code,
      release: health.release,
      origin,
      at: new Date(clock()).toISOString(),
    });
  } else if (action === "cancel-test") cancelWatchdogTest(state, clock());
  else if (action === "quarantine") quarantineWatchdog(state, clock());
  else {
    permission = await permissionCheck();
    if (permission)
      updateWatchdogPermission(state, config, permission, clock());
    if (config.delivery?.kind === "webpush" && permission !== "allowed") {
      await persist(directory, state);
      throw new WatchdogError("subscription_permission_unavailable");
    }
    if (action === "confirm-test")
      confirmWatchdogPushTest(state, config, testId, clock());
    else
      onlyId = requestWatchdogTest(
        state,
        config,
        action === "new-test",
        clock(),
      ).id;
  }
  pruneWatchdog(state, clock());
  await persist(directory, state);
  if (["cancel-test", "quarantine", "confirm-test"].includes(action))
    return watchdogStatus(state, config, clock());
  // A healthy application with an unreadable permission endpoint is not an outage lease.
  if (
    config.delivery?.kind === "webpush" &&
    permission !== "allowed" &&
    state.lastSample?.healthy
  )
    return watchdogStatus(state, config, clock());
  const job = dueWatchdog(state, config, clock(), onlyId);
  if (!job) return watchdogStatus(state, config, clock());
  beginWatchdogDelivery(job, clock());
  await persist(directory, state);
  let dispatched = false;
  /** @type {import('./telegram.mjs').DeliveryResult} */
  let result = { state: "cancelled", code: "cancelled_before_dispatch" };
  try {
    const latest = await readWatchdogConfig(configFile);
    reconcileWatchdog(state, latest, clock());
    config = latest;
    const bindings = watchdogBindings(config);
    if (
      !signal?.aborted &&
      config.delivery &&
      !job.cancelRequested &&
      job.target === bindings.target &&
      job.destination === bindings.destination &&
      ((job.kind === "test" &&
        (!state.quarantined || !config.delivery.enabled)) ||
        watchdogDeliveryEnabled(state, config, clock()))
    ) {
      dispatched = true;
      result =
        config.delivery.kind === "webpush"
          ? await sendPush({
              subscription: config.delivery.subscription,
              vapid: config.delivery.vapid,
              payload: {
                title: "Solarman",
                body:
                  config.language === "bg"
                    ? job.kind === "test"
                      ? "Проверка от независимия сървър за наблюдение."
                      : job.kind === "outage"
                        ? "Таблото не отговаря нормално. Проверете системата."
                        : "Таблото отново отговаря нормално."
                    : job.kind === "test"
                      ? "Test from the independent monitoring server."
                      : job.kind === "outage"
                        ? "The dashboard health check failed. Check the system."
                        : "The dashboard is responding normally again.",
                url: "/settings/health",
                reference: job.id,
              },
              signal,
            })
          : await send({
              botToken: config.delivery.botToken,
              chatId: config.delivery.chatId,
              text: job.text,
              signal,
            });
    }
  } catch {
    result = dispatched
      ? { state: "unconfirmed", code: "delivery_unconfirmed" }
      : { state: "retry", code: "dispatch_check_failed" };
  }
  try {
    config = await readWatchdogConfig(configFile);
    reconcileWatchdog(state, config, clock());
  } catch {
    job.cancelRequested = true;
    state.verifiedAt = null;
  }
  completeWatchdogDelivery(state, job, result, clock());
  pruneWatchdog(state, clock());
  await persist(directory, state);
  return watchdogStatus(state, config, clock());
}

/** @param {string} configFile @param {string} directory @returns {Promise<object>} */
export async function currentWatchdogStatus(configFile, directory) {
  const config = await readWatchdogConfig(configFile),
    state = await readWatchdogState(directory);
  return watchdogStatus(state, config);
}
