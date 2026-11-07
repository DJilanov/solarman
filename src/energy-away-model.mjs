import { learnEnergyDemand, predictEnergyDemand } from "./energy-history.mjs";
import { chooseEnergyPlan } from "./energy-model.mjs";
import { energyNightWindows } from "./energy-time.mjs";

/** @param {object} profile @param {object[]} rows @param {object[]} solar @param {object} request @param {object} occupancy @param {number} [now] @returns {object} */
export function previewAwayPlan(profile, rows, solar, request, occupancy, now = Date.now()) {
  const latest = rows.at(-1);
  if (!latest || now - new Date(latest.observed_at).getTime() > 10 * 60000)
    throw new Error("Fresh battery readings are required to preview Away mode");
  const model = learnEnergyDemand(rows, profile, now, solar, occupancy.history, occupancy.normalModel);
  const to = energyNightWindows(profile, now)[1]?.start;
  if (!to) throw new Error("The weather forecast does not cover the plan horizon");
  const proposed = [...occupancy.future, { id: "preview", ...request }];
  const normal = predictEnergyDemand(model, profile, solar, now, to, occupancy.future);
  const adjusted = predictEnergyDemand(model, profile, solar, now, to, proposed);
  const input = { profile, solar, soc: latest.soc, initialDischarging: latest.battery_w >= 250, now };
  const before = chooseEnergyPlan({ ...input, demand: normal });
  const after = chooseEnergyPlan({ ...input, demand: adjusted });
  return {
    from: new Date(now).toISOString(), through: new Date(to).toISOString(),
    normalLoadKwh: normal.reduce((sum, slot) => sum + slot.expectedKw * slot.hours, 0),
    awayLoadKwh: adjusted.reduce((sum, slot) => sum + slot.expectedKw * slot.hours, 0),
    targetBefore: before.targetSoc, targetAfter: after.targetSoc,
    appliesInHorizon: adjusted.some(slot => slot.awayPeriodId === "preview"),
    reserveSoc: profile.battery.reserveSoc,
    timeline: adjusted.map((slot, index) => ({ at: new Date(slot.start).toISOString(), normalKw: normal[index].expectedKw,
      awayKw: slot.expectedKw, away: slot.source === "away-estimate" })),
    estimated: true, changesInverter: false,
  };
}
