import {
  readCommand,
  writeCommand,
  decodeReply,
  unsigned32,
  signed32,
  signed16,
  flagRegisters,
} from "./modbus.mjs";

const AC_BIT = 0x10;
const EXPECTED_BASE_FLAGS = 0x09;

/**
 * @typedef {object} Snapshot
 * @property {number} flags
 * @property {number} mode
 * @property {number} acPowerRaw
 * @property {number} acTargetRaw
 * @property {number[]} windows
 * @property {number} batteryState
 * @property {number} soc
 * @property {number} batteryW
 * @property {number} temperatureC
 * @property {number} pvW
 * @property {number} loadW
 * @property {number} gridW
 * @property {number[]} gridVoltages
 */

/** @param {Snapshot} snapshot @returns {{ charge: boolean, reason: string, solarSurplusW: number }} */
export function decide(snapshot) {
  const solarSurplusW = Math.max(0, snapshot.pvW - snapshot.loadW);
  const result = (charge, reason) => ({ charge, reason, solarSurplusW });
  if (snapshot.soc >= 50) return result(false, "reserve_reached");
  if (![4, 5, 6].includes(snapshot.batteryState))
    return result(false, "battery_not_ready");
  if (snapshot.gridVoltages.some((v) => v < 100 || v > 300))
    return result(false, "grid_not_available");
  const enabled = Boolean(snapshot.flags & AC_BIT);
  // Avoid switching repeatedly when solar surplus fluctuates around the AC target.
  if (solarSurplusW >= (enabled ? 2000 : 1800))
    return result(false, "solar_can_charge");
  return result(true, "below_reserve");
}

/** @param {number} minutes @returns {number} */
function encodeTime(minutes) {
  return Math.floor(minutes / 60) * 256 + (minutes % 60);
}

/** @param {number} encoded @returns {number} */
function decodeTime(encoded) {
  const hours = encoded >>> 8;
  const minutes = encoded & 255;
  if (hours > 23 || minutes > 59)
    throw new Error("Invalid inverter charge-window time");
  return hours * 60 + minutes;
}

/** @param {Date} date @param {string} timezone @param {number} duration @returns {number[] | null} */
export function chargeWindows(date, timezone, duration) {
  if (!Number.isInteger(duration) || duration < 5 || duration > 45)
    throw new Error("Invalid charging-window duration");
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(date);
  const hour = Number(parts.find((p) => p.type === "hour")?.value);
  const minute = Number(parts.find((p) => p.type === "minute")?.value);
  const now = hour * 60 + minute;
  // The related firmware's documented midnight boundary is 00:01 through 23:59.
  if (now === 0 || now === 1439) return null;
  const start = Math.max(1, now - 1);
  const end = now + duration;
  if (end <= 1439)
    return [encodeTime(start), encodeTime(end), 0, 0, 0, 0, 0, 0];
  if (end <= 1441)
    return [encodeTime(start), encodeTime(1439), 0, 0, 0, 0, 0, 0];
  return [
    encodeTime(start),
    encodeTime(1439),
    encodeTime(1),
    encodeTime(end - 1440),
    0,
    0,
    0,
    0,
  ];
}

/** @param {number[]} windows @param {number} maximumDuration @returns {boolean} */
export function boundedWindows(windows, maximumDuration) {
  if (windows.length !== 8 || windows.slice(4).some((v) => v !== 0))
    return false;
  const [start, end, start2, end2] = windows.map(decodeTime);
  if (start2 === 0 && end2 === 0)
    return start >= 1 && end > start && end - start <= maximumDuration;
  return (
    start >= 1 &&
    end === 1439 &&
    start2 === 1 &&
    end2 > start2 &&
    end2 < start &&
    end - start + end2 - start2 <= maximumDuration
  );
}

export class BatteryController {
  /**
   * @param {{ command: (command: string) => Promise<string> }} client
   * @param {{ writesEnabled: boolean, timezone: string, chargeWindowMinutes: number,
   *   log?: (event: object) => void, isStopping?: () => boolean, now?: () => Date }} options
   */
  constructor(client, options) {
    this.client = client;
    this.options = options;
    this.log = options.log ?? (() => {});
    this.now = options.now ?? (() => new Date());
  }

  /** @param {number} fn @param {number} address @param {number} count @returns {Promise<number[]>} */
  async read(fn, address, count) {
    const command = readCommand(fn, address, count);
    return decodeReply(command, await this.client.command(command));
  }

  /** @param {number} address @param {number[]} values @returns {Promise<void>} */
  async writeVerified(address, values) {
    if (!this.options.writesEnabled) throw new Error("Writes are disabled");
    const command = writeCommand(address, values);
    decodeReply(command, await this.client.command(command));
    const actual = await this.read(3, address, values.length);
    if (actual.some((v, i) => v !== values[i]))
      throw new Error("Inverter write readback mismatch");
  }

  /** @returns {Promise<void>} */
  async verifyProfile() {
    const settings = await this.settings();
    if (settings.maximumSoc !== 100 || settings.reserveSoc !== 50) {
      throw new Error(
        "Expected overall SOC maximum 100% and on-grid reserve 50%; no settings were changed",
      );
    }
  }

  /** @returns {Promise<{ maximumSoc: number, reserveSoc: number }>} */
  async settings() {
    const registers = await this.read(3, 3005, 32);
    return { maximumSoc: registers[0] / 10, reserveSoc: registers[31] / 10 };
  }

  /** @returns {Promise<Snapshot>} */
  async snapshot(validateSettings = true) {
    const startedAt = Date.now();
    const flags = unsigned32(await this.read(3, 206, 2));
    const setup = await this.read(3, 2500, 17);
    const battery = await this.read(4, 2000, 9);
    const flows = await this.read(4, 507, 48);
    if (Date.now() - startedAt > 120_000)
      throw new Error("Snapshot collection took too long");
    const snapshot = {
      flags,
      mode: setup[0],
      acPowerRaw: setup[4],
      acTargetRaw: setup[5],
      windows: setup.slice(9, 17),
      batteryState: battery[0],
      soc: battery[2],
      batteryW: signed32(battery, 7),
      temperatureC: signed16(battery[1]) / 10,
      gridVoltages: flows.slice(0, 3).map((v) => v / 10),
      gridW: signed32(flows, 28),
      loadW: unsigned32(flows, 40),
      pvW: unsigned32(flows, 46),
    };
    if (
      validateSettings &&
      ((flags & ~AC_BIT) !== EXPECTED_BASE_FLAGS ||
        snapshot.mode !== 0 ||
        snapshot.acPowerRaw !== 100 ||
        snapshot.acTargetRaw !== 500)
    ) {
      throw new Error(
        "Inverter is not in the verified BSE20KH3 SelfUse / 2 kW / 50% configuration",
      );
    }
    if (
      snapshot.soc > 100 ||
      snapshot.pvW > 100_000 ||
      snapshot.loadW > 100_000 ||
      Math.abs(snapshot.gridW) > 100_000 ||
      Math.abs(snapshot.batteryW) > 30_000 ||
      snapshot.temperatureC < -50 ||
      snapshot.temperatureC > 100 ||
      snapshot.gridVoltages.some((v) => v > 400)
    ) {
      throw new Error("Implausible live readings; refusing to enable charging");
    }
    return snapshot;
  }

  /** @param {boolean} enabled @returns {Promise<void>} */
  async setAc(enabled) {
    const flags = unsigned32(await this.read(3, 206, 2));
    if (
      enabled &&
      ((flags & ~AC_BIT) !== EXPECTED_BASE_FLAGS || this.options.isStopping?.())
    ) {
      throw new Error(
        "Charging enable interrupted by changed flags or shutdown",
      );
    }
    const next = enabled ? (flags | AC_BIT) >>> 0 : (flags & ~AC_BIT) >>> 0;
    if (flags === next) return;
    await this.writeVerified(206, flagRegisters(next));
    this.log({ event: "ac_charge_changed", enabled });
  }

  /** @returns {Promise<{ snapshot: Snapshot, decision: ReturnType<typeof decide> }>} */
  async tick() {
    const startedAt = Date.now();
    const snapshot = await this.snapshot();
    await this.verifyProfile();
    if (Date.now() - startedAt > 120_000)
      throw new Error("Live readings are too old for a control decision");
    const decision = decide(snapshot);
    const windows = chargeWindows(
      this.now(),
      this.options.timezone,
      this.options.chargeWindowMinutes,
    );
    if (!windows) {
      decision.charge = false;
      decision.reason = "midnight_boundary";
    }
    this.log({
      event: "decision",
      dryRun: !this.options.writesEnabled,
      soc: snapshot.soc,
      batteryW: snapshot.batteryW,
      pvW: snapshot.pvW,
      loadW: snapshot.loadW,
      gridW: snapshot.gridW,
      acEnabled: Boolean(snapshot.flags & AC_BIT),
      ...decision,
    });
    if (!this.options.writesEnabled) return { snapshot, decision };
    if (!decision.charge) {
      if (snapshot.flags & AC_BIT) {
        await this.setAc(false);
        snapshot.flags &= ~AC_BIT;
      }
      return { snapshot, decision };
    }
    // Only this service's short second window is allowed; preserve unrelated schedules by refusing them.
    if (
      snapshot.windows.slice(2).some((v) => v !== 0) &&
      !boundedWindows(snapshot.windows, this.options.chargeWindowMinutes + 2)
    ) {
      throw new Error(
        "Other AC charging windows exist; refusing to overwrite them",
      );
    }
    if (
      snapshot.flags & AC_BIT &&
      !boundedWindows(snapshot.windows, this.options.chargeWindowMinutes + 2)
    ) {
      await this.setAc(false);
    }
    if (this.options.isStopping?.()) throw new Error("Service is stopping");
    await this.writeVerified(2509, windows);
    await this.setAc(true);
    snapshot.flags |= AC_BIT;
    snapshot.windows = windows;
    return { snapshot, decision };
  }

  /** @returns {Promise<void>} */
  async disable() {
    if (!this.options.writesEnabled) return;
    await this.setAc(false);
  }
}
