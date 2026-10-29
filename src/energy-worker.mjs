import { parentPort, workerData } from "node:worker_threads";
import { chooseEnergyPlan } from "./energy-model.mjs";
import { scoreEnergyForecasts } from "./energy-outcomes.mjs";
if (!parentPort)
  throw new Error("Energy planning runs in its calculation worker");
try {
  if (!["plan", "outcomes"].includes(workerData.kind))
    throw new Error("Unsupported energy calculation");
  parentPort.postMessage({
    value:
      workerData.kind === "plan"
        ? chooseEnergyPlan(workerData.input)
        : scoreEnergyForecasts(workerData.input),
  });
} catch (error) {
  parentPort.postMessage({
    error:
      error instanceof Error
        ? error.message
        : "The energy plan could not be calculated",
  });
}
