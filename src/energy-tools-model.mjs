import { dayStart, localDay } from "./analytics.mjs";
import { energyIntervals, energyTariff, energyLocalTime } from "./energy-time.mjs";
import { energyMeasuredBuckets, energyQuantile } from "./energy-history.mjs";
import { scoreEnergyPlan } from "./energy-outcomes.mjs";
import { simulateEnergyPlan } from "./energy-model.mjs";

/** @param {unknown} value @param {number} min @param {number} max @param {string} message @returns {number} */
function bounded(value, min, max, message) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max)
    throw new Error(message);
  return value;
}

/** @param {object} body @param {number} now @returns {{start:number,end:number,mode:'household'|'essential',essentialW:number|null}} */
export function validateOutageRequest(body, now) {
  const start = typeof body.startsAt === "string" ? Date.parse(body.startsAt) : NaN;
  if (!Number.isFinite(start) || start < now - 60000 || start > now + 7 * 86400000)
    throw new Error("Choose an outage start within the next seven days");
  const hours = bounded(body.hours, 0.25, 72, "Choose an outage duration between 15 minutes and 72 hours");
  if (!["household", "essential"].includes(body.mode))
    throw new Error("Choose household or essential-load planning");
  const essentialW = body.mode === "essential"
    ? bounded(body.essentialW, 50, 50000, "Enter essential-load power between 50 W and 50 kW") : null;
  return { start, end: start + hours * 3600000, mode: body.mode, essentialW };
}

/** @param {object} profile @param {object[]} rows @param {object[]} solar @param {object} request @param {number} now @returns {object} */
export function planOutage(profile, rows, solar, request, now = Date.now()) {
  const latest = rows.at(-1), capacity = profile.battery.capacityKwh;
  if (!latest || now - new Date(latest.observed_at).getTime() > 10 * 60000)
    throw new Error("Fresh battery readings are required for outage planning");
  if (!Number.isFinite(capacity) || capacity <= 0)
    throw new Error("Enter battery capacity before planning an outage");
  const buckets = energyMeasuredBuckets(rows), recent = buckets.filter(b => b.end >= now - 7 * 86400000);
  const typical = energyQuantile(recent.filter(b => b.coverage >= 0.9).map(b => b.loadKwh * 4), 0.65);
  if (request.mode === "household" && typical === null)
    throw new Error("More household readings are required; use an essential-load estimate");
  const hourlyLoads = new Map();
  for (const bucket of recent.filter(b => b.coverage >= 0.9)) {
    const hour = Math.floor(energyLocalTime(bucket.start, profile.timezone).minute / 60);
    if (!hourlyLoads.has(hour)) hourlyLoads.set(hour, []);
    hourlyLoads.get(hour).push(bucket.loadKwh * 4);
  }
  const slots = energyIntervals(request.start, request.end).map(interval => {
    const hour = Math.floor(energyLocalTime(interval.start, profile.timezone).minute / 60);
    const loadKw = request.mode === "essential" ? request.essentialW / 1000
      : (energyQuantile(hourlyLoads.get(hour) ?? [], 0.65) ?? typical) * (1 + profile.planning.loadMargin);
    const forecast = solar.find(s => s.start <= interval.start && s.end >= interval.end);
    return { ...interval, loadKw, solarKw: forecast?.lowKw ?? 0, solarKnown: Boolean(forecast) };
  });
  const simulate = soc => {
    let energy = capacity * soc / 100, unservedKwh = 0, powerShortfallKwh = 0;
    const floor = capacity * profile.battery.backupFloorSoc / 100;
    for (const slot of slots) {
      const surplus = Math.max(0, slot.solarKw - slot.loadKw) * slot.hours;
      energy += Math.min(surplus, profile.battery.pvChargeKw * slot.hours,
        Math.max(0, (capacity - energy) / profile.battery.chargeEfficiency)) * profile.battery.chargeEfficiency;
      const deficit = Math.max(0, slot.loadKw - slot.solarKw) * slot.hours;
      const output = Math.min(deficit, profile.battery.dischargeKw * slot.hours,
        Math.max(0, energy - floor) * profile.battery.dischargeEfficiency);
      energy -= output / profile.battery.dischargeEfficiency;
      unservedKwh += deficit - output;
      powerShortfallKwh += Math.max(0, deficit - profile.battery.dischargeKw * slot.hours);
    }
    return { finalSoc: energy / capacity * 100, unservedKwh, powerShortfallKwh };
  };
  let target = 100;
  for (let soc = Math.ceil(profile.battery.reserveSoc); soc <= 100; soc++)
    if (simulate(soc).unservedKwh <= 0.01) { target = soc; break; }
  const result = simulate(target), current = simulate(latest.soc);
  const chargingKwh = Math.max(0, capacity * (target - latest.soc) / 100) / profile.battery.chargeEfficiency;
  const chargingHours = chargingKwh / profile.battery.gridChargeKw;
  return {
    startsAt: new Date(request.start).toISOString(), endsAt: new Date(request.end).toISOString(), mode: request.mode,
    targetSoc: target, currentSoc: latest.soc, shortfallKwh: result.unservedKwh,
    currentShortfallKwh: current.unservedKwh, powerShortfallKwh: result.powerShortfallKwh,
    loadKwh: slots.reduce((s, v) => s + v.loadKw * v.hours, 0),
    conservativeSolarKwh: slots.reduce((s, v) => s + v.solarKw * v.hours, 0),
    solarCoverage: slots.filter(s => s.solarKnown).length / slots.length,
    chargingHours, chargingKwh, readyAt: new Date(now + chargingHours * 3600000).toISOString(),
    readyBeforeStart: now + chargingHours * 3600000 <= request.start,
    feasible: result.unservedKwh <= 0.01,
    powerAssumed: !profile.battery.powerConfirmed, estimated: true,
  };
}

/** @param {object} body @param {number} now @returns {object} */
export function validateLoadTask(body, now = Date.now()) {
  if (typeof body.name !== "string" || !body.name.trim() || body.name.trim().length > 80)
    throw new Error("Name the appliance using up to 80 characters");
  const powerKw = bounded(body.powerKw, 0.05, 50, "Enter appliance power between 0.05 and 50 kW");
  const durationMinutes = bounded(body.durationMinutes, 15, 1440, "Choose an appliance duration between 15 minutes and 24 hours");
  if (!Number.isInteger(durationMinutes) || typeof body.reminderEnabled !== "boolean")
    throw new Error("Enter a whole-minute duration and choose whether to send a reminder");
  const earliest = typeof body.earliestAt === "string" ? Date.parse(body.earliestAt) : NaN,
    deadline = typeof body.deadlineAt === "string" ? Date.parse(body.deadlineAt) : NaN;
  if (!Number.isFinite(earliest) || !Number.isFinite(deadline) || earliest < now - 60000 || deadline > now + 7 * 86400000 || deadline - earliest < durationMinutes * 60000)
    throw new Error("Choose a future appliance window long enough to finish before its deadline");
  return { name: body.name.trim(), powerKw, durationMinutes, earliest, deadline, reminderEnabled: body.reminderEnabled };
}

/** @param {object} profile @param {object[]} solar @param {object[]} rows @param {object} task @returns {object} */
export function planLoadTask(profile, solar, rows, task) {
  const measured = energyMeasuredBuckets(rows).filter(b => b.coverage >= 0.9);
  const baseKw = energyQuantile(measured.map(b => b.loadKwh * 4), 0.65);
  if (baseKw === null) throw new Error("More household readings are required before scheduling an appliance");
  const latest = rows.at(-1), from = Math.min(new Date(latest.observed_at).getTime(), task.earliest);
  const demand = energyIntervals(from, task.deadline).map(interval => ({ ...interval, expectedKw: baseKw, highKw: baseKw }));
  if (demand.some(interval => !solar.some(s => s.start <= interval.start && s.end >= interval.end)))
    throw new Error("Refresh the solar forecast to cover the appliance window");
  const baseline = simulateEnergyPlan(profile, solar, demand, { from, to: task.deadline, soc: latest.soc,
    initialDischarging: latest.battery_w >= 250, scenario: "conservative" });
  let best = null;
  const starts = [task.earliest];
  for (let at = Math.ceil(task.earliest / 900000) * 900000; at + task.durationMinutes * 60000 <= task.deadline; at += 900000) starts.push(at);
  for (const start of new Set(starts)) {
    let cost = 0, solarKwh = 0, covered = true;
    for (const interval of energyIntervals(start, start + task.durationMinutes * 60000)) {
      const slot = solar.find(s => s.start <= interval.start && s.end >= interval.end);
      if (!slot) { covered = false; break; }
      const batteryPlan = baseline.timeline.find(s => s.start <= interval.start && s.end >= interval.end);
      const surplus = batteryPlan?.surplusKw ?? 0, solarKw = Math.min(task.powerKw, surplus);
      solarKwh += solarKw * interval.hours;
      const tariff = energyTariff(profile, interval.start);
      cost += ((task.powerKw - solarKw) * tariff.buy + solarKw * tariff.export) * interval.hours;
    }
    if (covered && (!best || cost < best.estimatedCost - 1e-9 || (Math.abs(cost - best.estimatedCost) <= 1e-9 && solarKwh > best.solarKwh)))
      best = { suggestedAt: new Date(start).toISOString(), finishesAt: new Date(start + task.durationMinutes * 60000).toISOString(), estimatedCost: cost, solarKwh };
  }
  if (!best) throw new Error("Refresh the solar forecast to cover the appliance window");
  return { ...best, energyKwh: task.powerKw * task.durationMinutes / 60, householdBaselineKw: baseKw, batteryPriority: true, estimated: true, switchesAppliance: false };
}

/** @param {object} profile @param {object[]} rows @param {object[]} plans @param {number} now @returns {object} */
export function weeklyEnergyReport(profile, rows, plans, now = Date.now()) {
  const today = localDay(now, profile.timezone), end = dayStart(today, profile.timezone);
  const date = new Date(`${today}T12:00:00Z`); date.setUTCDate(date.getUTCDate() - 7);
  const fromDay = date.toISOString().slice(0, 10), start = dayStart(fromDay, profile.timezone);
  const buckets = energyMeasuredBuckets(rows).filter(b => b.start >= start && b.end <= end);
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(`${fromDay}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + i);
    const day = d.toISOString().slice(0, 10), next = new Date(d); next.setUTCDate(next.getUTCDate() + 1);
    const a = dayStart(day, profile.timezone), b = dayStart(next.toISOString().slice(0, 10), profile.timezone);
    const own = buckets.filter(v => v.start >= a && v.end <= b), sum = key => own.reduce((n, v) => n + v[key], 0);
    days.push({ day, coverage: own.reduce((n, v) => n + v.coveredSeconds * 1000, 0) / (b - a),
      solarKwh: sum("solarKwh"), loadKwh: sum("loadKwh"), importKwh: sum("importKwh"), exportKwh: sum("exportKwh"),
      batteryDischargeKwh: sum("dischargeKwh"), gridCost: own.reduce((n, v) => { const t = energyTariff(profile, v.start); return n + v.importKwh * t.buy - v.exportKwh * t.export; }, 0) });
  }
  const eligible = plans.filter(p => p.state === "completed" && !p.code && p.prediction.horizon.start >= start && p.prediction.horizon.end <= end);
  const assessed = eligible.map(p => scoreEnergyPlan(p, rows));
  return { fromDay, throughDay: days.at(-1).day, days, currency: profile.tariff.currency,
    gridCost: days.reduce((n, d) => n + d.gridCost, 0), solarKwh: days.reduce((n, d) => n + d.solarKwh, 0),
    importKwh: days.reduce((n, d) => n + d.importKwh, 0),
    coverage: buckets.reduce((n, b) => n + b.coveredSeconds * 1000, 0) / (end - start),
    estimatedSavings: assessed.some(p => p.estimatedCounterfactualSavings !== null)
      ? assessed.reduce((n, p) => n + (p.estimatedCounterfactualSavings ?? 0), 0) : null,
    assessedPlans: assessed.filter(p => p.estimatedCounterfactualSavings !== null).length,
    wearIncluded: profile.tariff.cyclingCost !== null, estimated: true };
}

/** @param {object[]} outcomes @param {object[]} rows @param {{now?:number,timezone?:string,forecasts?:object[]}} [options] @returns {object} */
export function energyLearning(outcomes, rows, options = {}) {
  const now = options.now ?? Date.now(), timezone = options.timezone ?? "Europe/Sofia";
  const byDay = new Map();
  for (const outcome of outcomes)
    if (!byDay.has(outcome.day) && outcome.coverage >= 0.95 && !outcome.curtailedPossible
      && Number.isFinite(outcome.forecastSolarKwh) && outcome.forecastSolarKwh > 0
      && Number.isFinite(outcome.actualSolarKwh) && outcome.actualSolarKwh >= 0
      && /^\d{4}-\d{2}-\d{2}$/.test(outcome.day) && outcome.day < localDay(now, timezone))
      byDay.set(outcome.day, outcome);
  const eligible = [...byDay.values()];
  const dailyErrors = eligible.map(o => o.actualSolarKwh - o.forecastSolarKwh);
  const buckets = energyMeasuredBuckets(rows), cycles = [];
  let segment = null;
  for (const row of rows) {
    const at = new Date(row.observed_at).getTime(), sign = row.battery_w > 250 ? 1 : row.battery_w < -250 ? -1 : 0;
    if (!sign || !segment || segment.sign !== sign || at - segment.lastAt > 2 * row.sampling_seconds * 1000) {
      if (segment && segment.sign === 1 && segment.firstSoc - segment.lastSoc >= 20 && segment.kwh > 0)
        cycles.push({ capacityKwh: segment.kwh / (Math.abs(segment.firstSoc - segment.lastSoc) / 100), direction: segment.sign === 1 ? "discharge" : "charge", at: new Date(segment.lastAt).toISOString() });
      segment = sign ? { sign, firstSoc: row.soc, lastSoc: row.soc, lastAt: at, lastW: Math.abs(row.battery_w), kwh: 0 } : null;
    } else {
      segment.kwh += (segment.lastW + Math.abs(row.battery_w)) / 2 / 1000 * (at - segment.lastAt) / 3600000;
      segment.lastAt = at; segment.lastW = Math.abs(row.battery_w); segment.lastSoc = row.soc;
    }
  }
  return {
    forecastDays: eligible.length, forecastStage: eligible.length >= 7 ? "measured-history" : "learning",
    meanAbsoluteErrorKwh: dailyErrors.length ? dailyErrors.reduce((n, e) => n + Math.abs(e), 0) / dailyErrors.length : null,
    forecastBiasKwh: dailyErrors.length ? dailyErrors.reduce((n, e) => n + e, 0) / dailyErrors.length : null,
    observedFullCapacityKwh: energyQuantile(cycles.map(c => c.capacityKwh), 0.5), qualifyingCycles: cycles.length,
    requiredSocChange: 20, measuredHours: buckets.reduce((n, b) => n + b.coveredSeconds / 3600, 0),
    batteryEstimateChangesSettings: false,
    hourlySolar: hourlySolarLearning(options.forecasts ?? [], rows, timezone, now),
  };
}

/** @param {object[]} forecasts @param {object[]} rows @param {string} timezone @param {number} now @returns {object[]} */
export function hourlySolarLearning(forecasts, rows, timezone, now = Date.now()) {
  const today = localDay(now, timezone), frozen = new Map(), groups = new Map(), curtailedDays = new Set();
  const localCache = new Map(), formatter = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" });
  const local = at => {
    const key = Math.floor(at / 3600000);
    if (!localCache.has(key)) {
      const p = Object.fromEntries(formatter.formatToParts(new Date(at)).map(v => [v.type, v.value]));
      localCache.set(key, { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) });
    }
    return localCache.get(key);
  };
  for (const forecast of [...forecasts].sort((a, b) => new Date(b.fetched_at) - new Date(a.fetched_at))) {
    for (const slot of forecast.payload.slots) {
      const { day } = local(slot.start);
      if (day >= today || new Date(forecast.fetched_at).getTime() >= dayStart(day, timezone)) continue;
      const key = slot.start;
      if (!frozen.has(key)) frozen.set(key, slot);
    }
  }
  for (const bucket of energyMeasuredBuckets(rows)) {
    const { day, hour } = local(bucket.start);
    if (bucket.curtailedPossible) curtailedDays.add(day);
    const slot = frozen.get(Math.floor(bucket.start / 3600000) * 3600000);
    if (!slot || bucket.coverage < 0.95 || day >= today) continue;
    const key = `${day}:${hour}`;
    if (!groups.has(key)) groups.set(key, { day, hour, actual: 0, expected: 0, raw: 0, seconds: 0 });
    const g = groups.get(key), hours = bucket.coveredSeconds / 3600;
    g.actual += bucket.solarKwh; g.expected += slot.expectedKw * hours; g.raw += slot.rawKw * hours; g.seconds += bucket.coveredSeconds;
  }
  return Array.from({ length: 24 }, (_, hour) => {
    const own = [...groups.values()].filter(g => g.hour === hour && g.seconds >= 3420 && g.raw >= 0.05 && !curtailedDays.has(g.day));
    const raw = own.reduce((n, g) => n + g.raw, 0), actual = own.reduce((n, g) => n + g.actual, 0);
    return { hour, days: own.length,
      rawScale: raw > 0 ? Math.max(0.25, Math.min(2, actual / raw)) : 1,
      meanAbsoluteErrorKwh: own.length ? own.reduce((n, g) => n + Math.abs(g.actual - g.expected), 0) / own.length : null };
  });
}
