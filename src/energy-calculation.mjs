import { Worker } from "node:worker_threads";

/** @template T @param {object} input @param {AbortSignal} [signal] @returns {Promise<T>} */
function runEnergyWorker(input, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Energy planning was cancelled"));
      return;
    }
    const worker = new Worker(new URL("./energy-worker.mjs", import.meta.url), {
      workerData: input,
    });
    let settled = false;
    const finish = (error, plan) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      void worker.terminate();
      error ? reject(error) : resolve(plan);
    };
    const abort = () => finish(new Error("Energy planning was cancelled"));
    const timer = setTimeout(
      () => finish(new Error("Energy calculation exceeded its time limit")),
      20000,
    );
    signal?.addEventListener("abort", abort, { once: true });
    worker.once("message", (message) =>
      message && Object.hasOwn(message, "value")
        ? finish(null, message.value)
        : finish(new Error(message?.error ?? "Energy calculation failed")),
    );
    worker.once("error", () => finish(new Error("Energy calculation failed")));
    worker.once("exit", () => {
      if (!settled)
        finish(new Error("Energy calculation stopped before completion"));
    });
  });
}

/** @param {object} input @param {AbortSignal} [signal] @returns {Promise<object>} */
export function calculateEnergyPlan(input, signal) {
  return runEnergyWorker({ kind: "plan", input }, signal);
}
/** @param {object} input @param {AbortSignal} [signal] @returns {Promise<object[]>} */
export function calculateEnergyOutcomes(input, signal) {
  return runEnergyWorker({ kind: "outcomes", input }, signal);
}
