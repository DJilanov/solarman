import { parentPort, workerData } from "node:worker_threads";
import { chooseEnergyPlan } from "./energy-model.mjs";
import { scoreEnergyForecasts } from "./energy-outcomes.mjs";
import { planOutage, planLoadTask, planApplianceSchedule } from "./energy-tools-model.mjs";
import { previewAwayPlan } from "./energy-away-model.mjs";
import { assessEnergyInsights } from "./energy-insights-model.mjs";
import { parseUtilityPublication } from "./energy-utility-model.mjs";
import { learnEnergyDemand } from "./energy-history.mjs";
if (!parentPort)
  throw new Error("Energy planning runs in its calculation worker");
try {
  if (!["plan", "outcomes", "experience"].includes(workerData.kind))
    throw new Error("Unsupported energy calculation");
  let value;
  if (workerData.kind === "experience") {
    const { profile, rows, solar, request } = workerData.input;
    if (workerData.action === "outage") value = planOutage(profile, rows, solar, request);
    else if (workerData.action === "load") value = planLoadTask(profile, solar, rows, request, workerData.input.reservations ?? []);
    else if (workerData.action === "schedule") value = planApplianceSchedule(profile, solar, rows, workerData.input.tasks, workerData.input.now);
    else if (workerData.action === "away") value = previewAwayPlan(profile, rows, solar, request, workerData.input.occupancy, workerData.input.now);
    else if (workerData.action === "normal-demand") value = learnEnergyDemand(rows, profile, Date.now(), solar, workerData.input.occupancy.history, workerData.input.occupancy.normalModel);
    else if (workerData.action === "insights") value = assessEnergyInsights({ profile, rows, forecasts: workerData.input.forecasts, away: workerData.input.occupancy?.history, online: workerData.input.online, now: workerData.input.now });
    else if (workerData.action === "publication") {
      const bytes = request.bytes;
      if (!(bytes instanceof Uint8Array) || bytes.byteLength > 5 * 1024 * 1024 || bytes.byteLength < 20) throw new Error("utility-format");
      const { getDocumentProxy, extractText } = await import("unpdf");
      const document = await getDocumentProxy(bytes, { isEvalSupported: false, useSystemFonts: false });
      try {
        if (document.numPages > 80) throw new Error("utility-too-large");
        const { text } = await extractText(document, { mergePages: true });
        if (text.length > 500000) throw new Error("utility-too-large");
        value = parseUtilityPublication(text);
      } finally { await document.loadingTask.destroy(); }
    }
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
