import {
  OUTAGE_WINDOWS,
  allowedOutageWrite,
  normalSettingsMatch,
  outageBaseline,
  outageSettingsMatch,
  outageTarget,
  sameBatteryProtection,
  sameWords,
  validateOutageBaseline,
} from "./outage-policy.mjs";

export class OutageNativeController {
  /** @param {import('./controller.mjs').BatteryController} inspector @param {(address:number,values:number[],phase:'apply'|'restore')=>Promise<void>} write */
  constructor(inspector, write, windows = OUTAGE_WINDOWS) {
    this.windows = windows;
    this.inspector = inspector;
    this.write = write;
  }

  /** @returns {Promise<{snapshot:object,batterySettings:number[]}>} */
  async read() {
    const started = Date.now();
    const snapshot = await this.inspector.snapshot(false);
    const batterySettings = await this.inspector.read(3, 3005, 32);
    if (Date.now() - started > 120_000)
      throw new Error("Live readings are too old");
    return { snapshot, batterySettings };
  }

  /** @returns {Promise<object>} */
  async baseline() {
    const { snapshot, batterySettings } = await this.read();
    if (
      !snapshot.gridVoltages.every((value) => value >= 100 && value <= 300) ||
      ![4, 5, 6].includes(snapshot.batteryState)
    )
      throw new Error(
        "An available grid and a ready battery are required for outage preparation",
      );
    const rated = await this.inspector.read(4, 7, 2);
    if (rated[0] * 65536 + rated[1] !== 20000)
      throw new Error(
        "The outage profile requires the verified 20 kW inverter",
      );
    return outageBaseline(snapshot, batterySettings);
  }

  /** @param {object} baseline @param {number} target @returns {Promise<object>} */
  async apply(baseline, target) {
    validateOutageBaseline(baseline);
    outageTarget(target);
    const previous = new Map([
      [2500, [baseline.mode]],
      [2505, [baseline.acTargetRaw]],
      [2509, baseline.windows],
      [206, [0, baseline.flags]],
    ]);
    for (const [address, values] of [
      [2500, [3]],
      [2505, [target * 10]],
      [2509, [...this.windows]],
      [206, [0, 25]],
    ]) {
      if (
        !allowedOutageWrite(
          baseline,
          target,
          "apply",
          address,
          values,
          this.windows,
        )
      )
        throw new Error("Outage setting is not allowed");
      if (
        !sameWords(
          await this.inspector.read(3, address, values.length),
          previous.get(address),
        )
      )
        throw new Error("Inverter settings changed before outage preparation");
      await this.write(address, values, "apply");
    }
    const { snapshot, batterySettings } = await this.read();
    if (
      !outageSettingsMatch(
        snapshot,
        batterySettings,
        baseline,
        target,
        this.windows,
      )
    )
      throw new Error("Outage settings could not be verified");
    return snapshot;
  }

  /** @param {object} baseline @param {number} target @returns {Promise<object>} */
  async restore(baseline, target) {
    validateOutageBaseline(baseline);
    outageTarget(target);
    const { snapshot, batterySettings } = await this.read();
    if (!snapshot.gridVoltages.every((value) => value >= 100 && value <= 300))
      throw new Error("Normal settings will be restored when the grid returns");
    const rated = await this.inspector.read(4, 7, 2);
    if (rated[0] * 65536 + rated[1] !== 20000)
      throw new Error("Verify the original inverter before restoring settings");
    if (
      !sameBatteryProtection(batterySettings, baseline.batterySettings) ||
      snapshot.acPowerRaw !== baseline.acPowerRaw ||
      ![0, 3].includes(snapshot.mode) ||
      ![baseline.acTargetRaw, target * 10].includes(snapshot.acTargetRaw) ||
      ![9, 25].includes(snapshot.flags) ||
      (!sameWords(snapshot.windows, baseline.windows) &&
        !sameWords(snapshot.windows, this.windows))
    )
      throw new Error(
        "Inverter settings changed outside outage preparation; review them before restoring",
      );
    const actual = new Map([
      [206, [snapshot.flags >>> 16, snapshot.flags & 65535]],
      [2509, snapshot.windows],
      [2505, [snapshot.acTargetRaw]],
      [2500, [snapshot.mode]],
    ]);
    for (const [address, values] of [
      [206, [0, baseline.flags]],
      [2509, baseline.windows],
      [2505, [baseline.acTargetRaw]],
      [2500, [baseline.mode]],
    ]) {
      if (
        !allowedOutageWrite(
          baseline,
          target,
          "restore",
          address,
          values,
          this.windows,
        )
      )
        throw new Error("Outage restoration is not allowed");
      if (
        !sameWords(
          await this.inspector.read(3, address, values.length),
          actual.get(address),
        )
      )
        throw new Error("Inverter settings changed during restoration");
      if (!sameWords(actual.get(address), values))
        await this.write(address, values, "restore");
    }
    const result = await this.read();
    if (!normalSettingsMatch(result.snapshot, result.batterySettings, baseline))
      throw new Error("Normal settings could not be verified");
    return result.snapshot;
  }
}
