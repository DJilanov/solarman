export const OUTAGE_MAPPING =
  "bluesun-maintain3/ac-soc-x10/solar100/eps-preserved/v1";
export const OUTAGE_WINDOWS = Object.freeze([1, 0x173b, 0, 0, 0, 0, 0, 0]);
export const OUTAGE_OPEN_STATES = Object.freeze([
  "queued",
  "applying",
  "active",
  "restoring",
  "recovery-required",
  "quarantined",
]);

/** @param {unknown} target @returns {number} */
export function outageTarget(target) {
  if (!Number.isInteger(target) || target < 50 || target > 100)
    throw new Error("Choose a whole-number outage target between 50% and 100%");
  return target;
}

/** @param {object} value @returns {void} */
export function validateOutageBaseline(value) {
  if (
    !value ||
    value.flags !== 9 ||
    value.mode !== 0 ||
    value.acPowerRaw !== 100 ||
    value.acTargetRaw !== 500 ||
    !Array.isArray(value.batterySettings) ||
    value.batterySettings.length !== 32 ||
    !value.batterySettings.every(
      (v) => Number.isInteger(v) && v >= 0 && v <= 65535,
    ) ||
    value.batterySettings[0] !== 1000 ||
    value.batterySettings[31] !== 500 ||
    !Array.isArray(value.windows) ||
    value.windows.length !== 8 ||
    !value.windows.every((v) => Number.isInteger(v) && v >= 0 && v <= 65535)
  )
    throw new Error(
      "Normal inverter settings must be verified before outage preparation",
    );
  // These windows are saved while scheduled charging is off, and restored with it off.
  for (let index = 0; index < 8; index += 2) {
    const start = value.windows[index],
      end = value.windows[index + 1];
    if (
      start >>> 8 > 23 ||
      end >>> 8 > 23 ||
      (start & 255) > 59 ||
      (end & 255) > 59 ||
      ((start !== 0 || end !== 0) && start >= end)
    )
      throw new Error(
        "Other charging schedules exist; review them before outage preparation",
      );
  }
}

/** @param {object} snapshot @param {number[]} batterySettings @returns {object} */
export function outageBaseline(snapshot, batterySettings) {
  const baseline = {
    flags: snapshot.flags,
    mode: snapshot.mode,
    acPowerRaw: snapshot.acPowerRaw,
    acTargetRaw: snapshot.acTargetRaw,
    windows: [...snapshot.windows],
    batterySettings: [...batterySettings],
  };
  validateOutageBaseline(baseline);
  return baseline;
}

/** @param {unknown[]} first @param {unknown[]} second @returns {boolean} */
export function sameWords(first, second) {
  return (
    Array.isArray(first) &&
    Array.isArray(second) &&
    first.length === second.length &&
    first.every((value, index) => value === second[index])
  );
}

/** @param {number[]} first @param {number[]} second @returns {boolean} */
export function sameBatteryProtection(first, second) {
  return (
    Array.isArray(first) &&
    Array.isArray(second) &&
    first.length === 32 &&
    second.length === 32 &&
    [0, 1, 31].every((index) => first[index] === second[index])
  );
}

/** @param {object} snapshot @param {number[]} settings @param {object} baseline @param {number} target @returns {boolean} */
export function outageSettingsMatch(
  snapshot,
  settings,
  baseline,
  target,
  windows = OUTAGE_WINDOWS,
) {
  return (
    snapshot.mode === 3 &&
    snapshot.acTargetRaw === outageTarget(target) * 10 &&
    snapshot.acPowerRaw === baseline.acPowerRaw &&
    snapshot.flags === 25 &&
    sameWords(snapshot.windows, windows) &&
    sameBatteryProtection(settings, baseline.batterySettings)
  );
}

/** @param {object} snapshot @param {number[]} settings @param {object} baseline @returns {boolean} */
export function normalSettingsMatch(snapshot, settings, baseline) {
  return (
    snapshot.mode === baseline.mode &&
    snapshot.acTargetRaw === baseline.acTargetRaw &&
    snapshot.acPowerRaw === baseline.acPowerRaw &&
    snapshot.flags === baseline.flags &&
    sameWords(snapshot.windows, baseline.windows) &&
    sameBatteryProtection(settings, baseline.batterySettings)
  );
}

/** @param {object} baseline @param {number} target @param {'apply'|'restore'} phase @param {number} address @param {number[]} values @returns {boolean} */
export function allowedOutageWrite(
  baseline,
  target,
  phase,
  address,
  values,
  windows = OUTAGE_WINDOWS,
) {
  if (!["apply", "restore"].includes(phase)) return false;
  validateOutageBaseline(baseline);
  outageTarget(target);
  validateChargeWindows(windows);
  if (
    !Array.isArray(values) ||
    !values.every((v) => Number.isInteger(v) && v >= 0 && v <= 65535)
  )
    return false;
  const wanted =
    phase === "apply"
      ? new Map([
          [2500, [3]],
          [2505, [target * 10]],
          [2509, windows],
          [206, [0, 25]],
        ])
      : new Map([
          [206, [0, baseline.flags]],
          [2509, baseline.windows],
          [2505, [baseline.acTargetRaw]],
          [2500, [baseline.mode]],
        ]);
  return wanted.has(address) && sameWords(values, wanted.get(address));
}

/** @param {object} previous @param {object} snapshot @param {number} now @returns {object} */
export function observeOutageHold(previous, snapshot, now) {
  const proof = { ...previous };
  if (proof.lastAt && now <= Date.parse(proof.lastAt)) return proof;
  const grid = snapshot.gridVoltages.every((v) => v >= 100 && v <= 300);
  if (grid && snapshot.soc >= 52 && snapshot.batteryW > 250)
    proof.holdViolatedAt = new Date(now).toISOString();
  if (
    grid &&
    Number.isInteger(proof.targetSoc) &&
    snapshot.soc < proof.targetSoc &&
    snapshot.pvW < 100 &&
    snapshot.batteryW <= -250 &&
    snapshot.gridW - snapshot.loadW >= 250
  )
    proof.gridChargingObservedAt = new Date(now).toISOString();
  if (
    grid &&
    snapshot.soc >= 52 &&
    snapshot.loadW - snapshot.pvW >= 250 &&
    snapshot.gridW >= 250 &&
    snapshot.batteryW <= 100
  ) {
    const first = proof.holdFirstAt ? Date.parse(proof.holdFirstAt) : now;
    if (!proof.holdFirstAt) proof.holdFirstAt = new Date(now).toISOString();
    if (now - first >= 30_000 && now - first <= 20 * 60_000)
      proof.holdObservedAt = new Date(now).toISOString();
    else if (now - first > 20 * 60_000)
      proof.holdFirstAt = new Date(now).toISOString();
  } else if (!proof.holdObservedAt) delete proof.holdFirstAt;
  const atTarget =
    grid &&
    snapshot.soc >= proof.targetSoc &&
    snapshot.pvW < 100 &&
    snapshot.loadW >= 250 &&
    snapshot.gridW >= 250 &&
    Math.abs(snapshot.batteryW) <= 100;
  if (atTarget) {
    const first = proof.targetHoldFirstAt
      ? Date.parse(proof.targetHoldFirstAt)
      : now;
    if (!proof.targetHoldFirstAt || now - first > 20 * 60_000)
      proof.targetHoldFirstAt = new Date(now).toISOString();
    else if (now - first >= 30_000)
      proof.targetHoldObservedAt = new Date(now).toISOString();
  } else if (!proof.targetHoldObservedAt) delete proof.targetHoldFirstAt;
  if (snapshot.gridVoltages.every((v) => v < 100) && snapshot.batteryW >= 250)
    proof.backupUseObservedAt = new Date(now).toISOString();
  proof.lastAt = new Date(now).toISOString();
  proof.gridAvailable = grid;
  return proof;
}

/** @param {object} proof @returns {boolean} */
export function outageTestPassed(proof) {
  const applied = Date.parse(proof?.appliedAt),
    held = Date.parse(proof?.holdObservedAt),
    restored = Date.parse(proof?.restoredAt);
  const charging = Date.parse(proof?.gridChargingObservedAt),
    stopped = Date.parse(proof?.targetHoldObservedAt);
  return Boolean(
    !proof?.quarantinedAt &&
    !proof?.holdViolatedAt &&
    Number.isFinite(applied) &&
    Number.isFinite(held) &&
    Number.isFinite(restored) &&
    Number.isFinite(charging) &&
    Number.isFinite(stopped) &&
    applied <= charging &&
    charging <= stopped &&
    stopped <= restored &&
    applied <= held &&
    held <= restored &&
    proof?.applyWritesVerified &&
    proof?.restoreWritesVerified &&
    proof?.backupSettingsPreserved,
  );
}

/** @param {number[]} windows @returns {void} */
export function validateChargeWindows(windows) {
  if (!Array.isArray(windows) || windows.length !== 8)
    throw new Error("Invalid native charging window");
  const ranges = [];
  for (let index = 0; index < 8; index += 2) {
    const start = windows[index],
      end = windows[index + 1];
    if (
      ![start, end].every(
        (value) =>
          Number.isInteger(value) &&
          value >= 0 &&
          value >>> 8 <= 23 &&
          (value & 255) <= 59,
      )
    )
      throw new Error("Invalid native charging window");
    if (start === 0 && end === 0) continue;
    if (
      start === 0 ||
      start >= end ||
      ranges.some(([from, to]) => start < to && end > from)
    )
      throw new Error("Overlapping native charging windows");
    ranges.push([start, end]);
  }
  if (!ranges.length) throw new Error("A native charging window is required");
}
