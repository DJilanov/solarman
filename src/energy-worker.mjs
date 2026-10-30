import { parentPort, workerData } from "node:worker_threads";
import { chooseEnergyPlan } from "./energy-model.mjs";
import { scoreEnergyForecasts } from "./energy-outcomes.mjs";
import { planOutage, planLoadTask } from "./energy-tools-model.mjs";
if (!parentPort)
  throw new Error("Energy planning runs in its calculation worker");
try {
  if (!["plan", "outcomes", "experience"].includes(workerData.kind))
    throw new Error("Unsupported energy calculation");
  let value;
  if (workerData.kind === "experience") {
    const { profile, rows, solar, request } = workerData.input;
    if (workerData.action === "outage") value = planOutage(profile, rows, solar, request);
    else if (workerData.action === "load") value = planLoadTask(profile, solar, rows, request);
    else throw new Error("Unsupported energy tool calculation");
  } else value = workerData.kind === "plan"
    ? chooseEnergyPlan(workerData.input) : scoreEnergyForecasts(workerData.input);
  parentPort.postMessage({ value });
} catch (error) {
  parentPort.postMessage({
    error:
      error instanceof Error
        ? error.message
        : "The energy plan could not be calculated",
  });
}
