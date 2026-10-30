import {
  energyIntervals,
  energyNightWindows,
  energyTariff,
} from "./energy-time.mjs";
import {
  missingEnergyInputs,
  validateEnergyProfile,
  ENERGY_MODEL_VERSION,
} from "./energy-profile.mjs";

export const NIGHT_RELEASE_MARGIN_MS = 5 * 60000;
// This installed profile stayed idle at 53% and restarted after charging to 56%.
const DISCHARGE_RESTART_MARGIN_SOC = 6;

/** @param {object} profile @param {object[]} solar @param {object[]} demand @param {{from:number,to:number,soc:number,initialDischarging?:boolean,night?:{start:number,end:number},chargeStart?:number,targetSoc?:number,scenario?:'expected'|'conservative',includeTimeline?:boolean}} options @returns {object} */
export function simulateEnergyPlan(
  profile,
  solar,
  demand,
  {
    from,
    to,
    soc,
    initialDischarging = false,
    night = null,
    chargeStart = null,
    targetSoc = null,
    scenario = "expected",
    includeTimeline = true,
  },
) {
  if (!Number.isFinite(soc) || soc < 0 || soc > 100)
    throw new Error("A valid current battery reading is required");
  if (typeof initialDischarging !== "boolean")
    throw new Error("A valid current battery discharge state is required");
  const capacity = profile.battery.capacityKwh,
    floor = (capacity * profile.battery.reserveSoc) / 100,
    chargeEfficiency = profile.battery.chargeEfficiency,
    dischargeEfficiency = profile.battery.dischargeEfficiency;
  if (!Number.isFinite(capacity) || capacity <= 0)
    throw new Error("Battery capacity is required");
  const target = (capacity * (targetSoc ?? profile.battery.reserveSoc)) / 100;
  const restartSoc = Math.min(
    100,
    profile.battery.reserveSoc + DISCHARGE_RESTART_MARGIN_SOC,
  );
  let energy = (capacity * soc) / 100,
    dischargeEnabled = initialDischarging || soc >= restartSoc,
    importKwh = 0,
    exportKwh = 0,
    gridChargeKwh = 0,
    solarKwh = 0,
    loadKwh = 0,
    wear = 0,
    gridCost = 0,
    endNightSoc = null,
    minimumSoc = soc;
  const releaseAt = night ? night.end - NIGHT_RELEASE_MARGIN_MS : null,
    timeline = [];
  let solarIndex = 0,
    demandIndex = 0;
  for (const interval of energyIntervals(from, to)) {
    while (solar[solarIndex]?.end <= interval.start) solarIndex++;
    while (demand[demandIndex]?.end <= interval.start) demandIndex++;
    const solarSlot = solar[solarIndex],
      demandSlot = demand[demandIndex];
    if (
      !solarSlot ||
      !demandSlot ||
      solarSlot.start > interval.start ||
      demandSlot.start > interval.start ||
      solarSlot.end < interval.end ||
      demandSlot.end < interval.end
    )
      throw new Error(
        "Forecast data does not cover the complete planning horizon",
      );
    const solarKw =
        scenario === "conservative" ? solarSlot.lowKw : solarSlot.expectedKw,
      loadKw =
        scenario === "conservative" ? demandSlot.highKw : demandSlot.expectedKw;
    if (
      ![solarKw, loadKw].every((value) => Number.isFinite(value) && value >= 0)
    )
      throw new Error("Invalid solar or household forecast");
    const boundaries = [
      interval.start,
      interval.end,
      ...[night?.start, releaseAt, chargeStart].filter(
        (value) =>
          Number.isFinite(value) &&
          value > interval.start &&
          value < interval.end,
      ),
    ].sort((a, b) => a - b);
    let slotGrid = 0,
      slotExport = 0,
      slotCharge = 0,
      slotDischarge = 0,
      slotPvCharge = 0,
      slotCost = 0,
      slotWear = 0;
    for (let index = 1; index < boundaries.length; index++) {
      const at = boundaries[index - 1],
        end = boundaries[index],
        hours = (end - at) / 3600000;
      const tariff = energyTariff(profile, at),
        hold = Boolean(
          night && at >= Math.max(from, night.start) && at < releaseAt,
        );
      const generated = solarKw * hours,
        consumed = loadKw * hours,
        fromPv = Math.min(generated, consumed);
      let surplus = generated - fromPv,
        deficit = consumed - fromPv;
      const pvCharge = Math.min(
        surplus,
        profile.battery.pvChargeKw * hours,
        Math.max(0, (capacity - energy) / chargeEfficiency),
      );
      energy += pvCharge * chargeEfficiency;
      surplus -= pvCharge;
      if (hold) dischargeEnabled = false;
      else if ((energy / capacity) * 100 >= restartSoc - 1e-9)
        dischargeEnabled = true;
      const discharge = hold || !dischargeEnabled
        ? 0
        : Math.min(
            deficit,
            profile.battery.dischargeKw * hours,
            Math.max(0, energy - floor) * dischargeEfficiency,
          );
      energy -= discharge / dischargeEfficiency;
      if (energy <= floor + 1e-9) dischargeEnabled = false;
      deficit -= discharge;
      const gridTarget = hold && at >= chargeStart ? target : floor;
      const gridInput =
        hold && at < chargeStart
          ? 0
          : Math.min(
              profile.battery.gridChargeKw * 0.9 * hours,
              Math.max(0, (gridTarget - energy) / chargeEfficiency),
            );
      energy += gridInput * chargeEfficiency;
      const imported = deficit + gridInput,
        cost = imported * tariff.buy - surplus * tariff.export,
        cycling = discharge * (profile.tariff.cyclingCost ?? 0);
      gridCost += cost;
      wear += cycling;
      importKwh += imported;
      exportKwh += surplus;
      gridChargeKwh += gridInput;
      solarKwh += generated;
      loadKwh += consumed;
      minimumSoc = Math.min(minimumSoc, (energy / capacity) * 100);
      slotGrid += imported;
      slotExport += surplus;
      slotCharge += gridInput;
      slotDischarge += discharge;
      slotPvCharge += pvCharge;
      slotCost += cost;
      slotWear += cycling;
      if (night && at < releaseAt && end >= releaseAt)
        endNightSoc = (energy / capacity) * 100;
    }
    if (includeTimeline)
      timeline.push({
        ...interval,
        solarKw,
        loadKw,
        soc: (energy / capacity) * 100,
        gridKwh: slotGrid,
        gridChargeKwh: slotCharge,
        batteryDischargeKwh: slotDischarge,
        solarChargeKwh: slotPvCharge,
        exportKwh: slotExport,
        surplusKw: slotExport / interval.hours,
        cost: slotCost,
        cyclingCost: slotWear,
        night: energyTariff(profile, interval.start).night,
      });
  }
  return {
    timeline,
    importKwh,
    exportKwh,
    gridChargeKwh,
    solarKwh,
    loadKwh,
    gridCost,
    cyclingCost: wear,
    totalCost: gridCost + wear,
    finalSoc: (energy / capacity) * 100,
    minimumSoc,
    endNightSoc,
    estimated: true,
  };
}

/** @param {object} input @returns {object} */
export function chooseEnergyPlan({
  profile,
  solar,
  demand,
  soc,
  now,
  initialDischarging = false,
  targetOverride = null,
}) {
  validateEnergyProfile(profile);
  if (missingEnergyInputs(profile).length)
    throw new Error(
      "Complete the installation and tariff settings before planning",
    );
  if (
    targetOverride !== null &&
    (!Number.isInteger(targetOverride) ||
      targetOverride < profile.battery.reserveSoc ||
      targetOverride > profile.planning.maximumSoc)
  )
    throw new Error("Choose a target between the reserve and maximum target");
  const windows = energyNightWindows(profile, now),
    night = windows[0],
    next = windows[1];
  if (!night || !next)
    throw new Error(
      "The next two night-tariff windows could not be determined",
    );
  const from = now,
    to = next.start,
    firstStart = Math.max(
      night.start,
      Math.ceil((now + 2 * 60000) / 900000) * 900000,
    ),
    releaseAt = night.end - NIGHT_RELEASE_MARGIN_MS;
  const baseline = simulateEnergyPlan(profile, solar, demand, {
    from,
    to,
    soc,
    initialDischarging,
  });
  const conservativeBaseline = simulateEnergyPlan(profile, solar, demand, {
    from,
    to,
    soc,
    initialDischarging,
    scenario: "conservative",
  });
  const baselineObjective =
    baseline.totalCost * 0.65 + conservativeBaseline.totalCost * 0.35;
  let chosen = null,
    objective = targetOverride === null ? baselineObjective : Infinity,
    evaluated = 0;
  if (
    (targetOverride !== null ||
      profile.tariff.nightPrice < profile.tariff.dayPrice) &&
    firstStart < releaseAt
  ) {
    const starts = [];
    for (let at = firstStart; at < releaseAt; at += 900000) starts.push(at);
    for (
      let target = targetOverride ?? Math.ceil(profile.battery.reserveSoc);
      target <= (targetOverride ?? profile.planning.maximumSoc);
      target++
    )
      for (const start of starts) {
        const expected = simulateEnergyPlan(profile, solar, demand, {
          from,
          to,
          soc,
          initialDischarging,
          night,
          chargeStart: start,
          targetSoc: target,
          includeTimeline: false,
        });
        evaluated++;
        if (
          expected.endNightSoc === null ||
          expected.endNightSoc + 0.25 < target
        )
          continue;
        const conservative = simulateEnergyPlan(profile, solar, demand, {
          from,
          to,
          soc,
          initialDischarging,
          night,
          chargeStart: start,
          targetSoc: target,
          scenario: "conservative",
          includeTimeline: false,
        });
        if (
          conservative.endNightSoc === null ||
          conservative.endNightSoc + 0.25 < target
        )
          continue;
        const value = expected.totalCost * 0.65 + conservative.totalCost * 0.35;
        if (
          value < objective - 0.005 ||
          (chosen &&
            Math.abs(value - objective) < 0.005 &&
            target === chosen.targetSoc &&
            start > chosen.chargeStart)
        ) {
          chosen = {
            targetSoc: target,
            chargeStart: start,
            expected,
            conservative,
          };
          objective = value;
        }
      }
  }
  if (
    targetOverride === null &&
    chosen &&
    baseline.totalCost - chosen.expected.totalCost < 0.01
  )
    chosen = null;
  if (targetOverride !== null && !chosen)
    throw new Error(
      "The selected target cannot be reached in the remaining cheap period",
    );
  const selected = chosen
    ? simulateEnergyPlan(profile, solar, demand, {
        from,
        to,
        soc,
        initialDischarging,
        night,
        chargeStart: chosen.chargeStart,
        targetSoc: chosen.targetSoc,
      })
    : baseline;
  const stress = chosen
    ? simulateEnergyPlan(profile, solar, demand, {
        from,
        to,
        soc,
        initialDischarging,
        night,
        chargeStart: chosen.chargeStart,
        targetSoc: chosen.targetSoc,
        scenario: "conservative",
      })
    : conservativeBaseline;
  const reasons = targetOverride !== null ? ["manual-target"] : [];
  if (profile.tariff.nightPrice >= profile.tariff.dayPrice)
    reasons.push("night-not-cheaper");
  else if (!chosen) reasons.push("no-economic-topup");
  else {
    reasons.push(
      selected.gridChargeKwh > 0.01 ? "charge-at-night" : "preserve-for-day",
    );
    if (chosen.targetSoc === profile.planning.maximumSoc)
      reasons.push("target-ceiling");
  }
  if (profile.site.arrays.some((plane) => !plane.geometryConfirmed))
    reasons.push("assumed-roof-geometry");
  if (!profile.battery.powerConfirmed) reasons.push("assumed-battery-power");
  reasons.push("assumed-discharge-restart");
  if (profile.tariff.cyclingCost === null) reasons.push("wear-not-priced");
  return {
    version: ENERGY_MODEL_VERSION,
    generatedAt: new Date(now).toISOString(),
    horizon: { start: from, end: to },
    night: { start: night.start, end: night.end, releaseAt },
    action: chosen ? "charge-and-hold" : "normal",
    targetSoc: chosen?.targetSoc ?? profile.battery.reserveSoc,
    chargeStart: chosen?.chargeStart ?? null,
    chargeEnd: chosen ? releaseAt : null,
    maximumChargeKw: profile.battery.gridChargeKw,
    chargingHours: chosen
      ? Math.max(0, (releaseAt - chosen.chargeStart) / 3600000)
      : 0,
    estimatedSavings: chosen ? baseline.totalCost - selected.totalCost : 0,
    conservativeSavings: chosen
      ? conservativeBaseline.totalCost - stress.totalCost
      : 0,
    baseline: {
      timeline: baseline.timeline,
      totalCost: baseline.totalCost,
      gridCost: baseline.gridCost,
      importKwh: baseline.importKwh,
      solarKwh: baseline.solarKwh,
      loadKwh: baseline.loadKwh,
    },
    selected,
    conservative: {
      totalCost: stress.totalCost,
      importKwh: stress.importKwh,
      solarKwh: stress.solarKwh,
      loadKwh: stress.loadKwh,
      finalSoc: stress.finalSoc,
    },
    reasons,
    candidates: evaluated,
    assumptions: {
      chargingPowerFactor: 0.9,
      conservativeWeight: 0.35,
      releaseMarginMinutes: NIGHT_RELEASE_MARGIN_MS / 60000,
      savingsIncludeWear: profile.tariff.cyclingCost !== null,
      dischargeRestartMarginSoc: DISCHARGE_RESTART_MARGIN_SOC,
      initialDischarging,
    },
    estimated: true,
  };
}
