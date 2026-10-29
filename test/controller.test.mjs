import test from "node:test";
import assert from "node:assert/strict";
import {
  BatteryController,
  decide,
  chargeWindows,
  boundedWindows,
} from "../src/controller.mjs";
import { frame, parseFrame } from "../src/modbus.mjs";

const base = {
  flags: 9,
  mode: 0,
  acPowerRaw: 100,
  acTargetRaw: 500,
  windows: [0, 0x173b, 0, 0, 0, 0, 0, 0],
  batteryState: 6,
  soc: 30,
  batteryW: 0,
  temperatureC: 17,
  pvW: 0,
  loadW: 1200,
  gridW: 1200,
  gridVoltages: [230, 230, 230],
};

class Inverter {
  constructor(soc = 30, flags = 9) {
    this.holding = new Map([
      [206, 0],
      [207, flags],
      [2500, 0],
      [2504, 100],
      [2505, 500],
      [2509, 0],
      [2510, 0x173b],
      [3005, 1000],
      [3036, 500],
    ]);
    this.input = new Map([
      [2000, 6],
      [2001, 170],
      [2002, soc],
      [2003, 100],
      [2004, 2144],
      [507, 2300],
      [508, 2300],
      [509, 2300],
      [536, 1200],
      [548, 1200],
    ]);
    this.writes = [];
    this.ignoreWrites = false;
  }
  async command(hex) {
    const request = parseFrame(hex);
    const address = request.readUInt16BE(2);
    const count = request.readUInt16BE(4);
    if ([3, 4].includes(request[1])) {
      const registers = request[1] === 3 ? this.holding : this.input;
      const bytes = Buffer.alloc(3 + count * 2);
      bytes[0] = 1;
      bytes[1] = request[1];
      bytes[2] = count * 2;
      for (let i = 0; i < count; i++)
        bytes.writeUInt16BE(registers.get(address + i) ?? 0, 3 + i * 2);
      return frame(bytes);
    }
    assert.equal(request[1], 16);
    const values = Array.from({ length: count }, (_, i) =>
      request.readUInt16BE(7 + i * 2),
    );
    this.writes.push({ address, values });
    if (!this.ignoreWrites)
      values.forEach((value, i) => this.holding.set(address + i, value));
    return frame(request.subarray(0, 6));
  }
}

const options = {
  writesEnabled: true,
  timezone: "Europe/Sofia",
  chargeWindowMinutes: 25,
  now: () => new Date("2026-10-27T10:00:00Z"),
};

test("attended recovery preflight enables only permission and preserves charging limits and windows", async () => {
  const inverter = new Inverter(55);
  const before = new Map(inverter.holding);
  const controller = new BatteryController(inverter, options);
  const snapshot = await controller.enableRecoveryTest();
  assert.equal(snapshot.soc, 55);
  assert.equal(snapshot.flags, 9);
  assert.deepEqual(inverter.writes, [{ address: 206, values: [0, 25] }]);
  await controller.disable();
  assert.deepEqual(inverter.writes, [
    { address: 206, values: [0, 25] },
    { address: 206, values: [0, 9] },
  ]);
  assert.deepEqual(inverter.holding, before);
});

test("recovery testing rejects insufficient SOC, existing permission, battery faults, grid loss and incorrect policy without enabling", async () => {
  const cases = [
    { soc: 51 },
    { flags: 25 },
    { input: [2000, 1] },
    { input: [508, 0] },
    { holding: [2504, 250] },
    { holding: [2505, 1000] },
    { holding: [3005, 500] },
    { holding: [3036, 300] },
  ];
  for (const item of cases) {
    const inverter = new Inverter(item.soc ?? 55, item.flags ?? 9);
    if (item.input) inverter.input.set(...item.input);
    if (item.holding) inverter.holding.set(...item.holding);
    await assert.rejects(
      new BatteryController(inverter, options).enableRecoveryTest(),
    );
    assert.deepEqual(inverter.writes, []);
  }
});

test("recovery testing rechecks flags and cancellation immediately before enabling", async () => {
  for (const change of ["flags", "stop"]) {
    const inverter = new Inverter(55);
    let reads = 0,
      stopping = false;
    const controller = new BatteryController(
      {
        command: async (raw) => {
          const frame = parseFrame(raw);
          if (
            frame[1] === 3 &&
            frame.readUInt16BE(2) === 206 &&
            ++reads === 2
          ) {
            if (change === "flags") inverter.holding.set(207, 25);
            else stopping = true;
          }
          return inverter.command(raw);
        },
      },
      { ...options, isStopping: () => stopping },
    );
    await assert.rejects(
      controller.enableRecoveryTest(),
      /Charging (flags changed|enable interrupted)/,
    );
    assert.deepEqual(inverter.writes, []);
  }
});

test("recovery permission writes require readback and are never replayed on an ambiguous result", async () => {
  const inverter = new Inverter(55);
  inverter.ignoreWrites = true;
  await assert.rejects(
    new BatteryController(inverter, options).enableRecoveryTest(),
    /readback mismatch/,
  );
  assert.equal(inverter.writes.length, 1);
});

test("recovery testing rejects stale preflight and disabled host writes before enabling", async (t) => {
  const inverter = new Inverter(55);
  let at = 1000000;
  t.mock.method(Date, "now", () => at);
  const controller = new BatteryController(
    {
      command: async (raw) => {
        const frame = parseFrame(raw);
        if (frame[1] === 3 && frame.readUInt16BE(2) === 3005) at += 120001;
        return inverter.command(raw);
      },
    },
    options,
  );
  await assert.rejects(controller.enableRecoveryTest(), /too old/);
  assert.deepEqual(inverter.writes, []);
  await assert.rejects(
    new BatteryController(inverter, {
      ...options,
      writesEnabled: false,
    }).enableRecoveryTest(),
    /Writes are disabled/,
  );
  assert.deepEqual(inverter.writes, []);
});

test("clearing scheduled permission uses recovery capacity for the read, write and confirmation", async () => {
  const inverter = new Inverter(30, 25);
  const purposes = [];
  const controller = new BatteryController(
    {
      command: async (hex, requestOptions) => {
        purposes.push(requestOptions.purpose);
        return inverter.command(hex);
      },
    },
    options,
  );
  await controller.disable();
  assert.deepEqual(purposes, ["recovery", "recovery", "recovery"]);
  assert.equal(inverter.holding.get(207), 9);
  assert.equal(inverter.writes.length, 1);
});

test("policy stops charging at 50% and above, allowing native battery use", () => {
  for (const soc of [50, 51, 89, 100]) {
    assert.deepEqual(decide({ ...base, soc, flags: 25 }), {
      charge: false,
      reason: "reserve_reached",
      solarSurplusW: 0,
    });
  }
  assert.equal(decide(base).charge, true);
});

test("solar surplus takes priority; hysteresis avoids threshold flapping", () => {
  assert.equal(decide({ ...base, pvW: 3500 }).reason, "solar_can_charge");
  assert.equal(decide({ ...base, pvW: 3100 }).charge, false);
  assert.equal(decide({ ...base, flags: 25, pvW: 3100 }).charge, true);
  assert.equal(decide({ ...base, flags: 25, pvW: 3200 }).charge, false);
});

test("does not enable charging during grid loss or a battery fault", () => {
  assert.equal(decide({ ...base, gridVoltages: [0, 0, 0] }).charge, false);
  assert.equal(decide({ ...base, gridVoltages: [230, 0, 230] }).charge, false);
  assert.equal(decide({ ...base, batteryState: 1 }).charge, false);
});

test("windows are short, handle midnight, and reject an all-day program", () => {
  const normal = chargeWindows(
    new Date("2026-10-27T10:00:00Z"),
    "Europe/Sofia",
    25,
  );
  assert.deepEqual(normal, [0x0b3b, 0x0c19, 0, 0, 0, 0, 0, 0]);
  assert.equal(boundedWindows(normal, 27), true);
  assert.equal(boundedWindows(base.windows, 27), false);
  for (let minute = 0; minute < 1440; minute++) {
    const date = new Date(Date.UTC(2026, 9, 27, 0, minute));
    const windows = chargeWindows(date, "UTC", 25);
    assert.equal(
      windows === null || boundedWindows(windows, 27),
      true,
      `minute ${minute}`,
    );
  }
  assert.deepEqual(
    chargeWindows(new Date("2026-10-27T23:50:00Z"), "UTC", 25),
    [0x1731, 0x173b, 0x0001, 0x000f, 0, 0, 0, 0],
  );
  assert.equal(
    chargeWindows(new Date("2026-10-27T00:00:00Z"), "UTC", 25),
    null,
  );
});

test("at 89%, live controller clears AC permission and leaves all charge settings alone", async () => {
  const inverter = new Inverter(89, 25);
  await new BatteryController(inverter, options).tick();
  assert.equal(inverter.holding.get(207), 9);
  assert.deepEqual(inverter.writes, [{ address: 206, values: [0, 9] }]);
  assert.equal(inverter.holding.get(3005), 1000);
  assert.equal(inverter.holding.get(3036), 500);
});

test("below 50%, configures a bounded window before enabling charging", async () => {
  const inverter = new Inverter();
  const controller = new BatteryController(inverter, options);
  await controller.tick();
  assert.equal(inverter.holding.get(207), 25);
  assert.deepEqual(
    inverter.writes.map((w) => w.address),
    [2509, 206],
  );
  assert.equal(boundedWindows(inverter.writes[0].values, 27), true);
  assert.equal(inverter.holding.get(2504), 100);
  assert.equal(inverter.holding.get(2505), 500);
});

test("dry-run reports decisions without any mutation, including disable()", async () => {
  const inverter = new Inverter(89, 25);
  const controller = new BatteryController(inverter, {
    ...options,
    writesEnabled: false,
  });
  const { decision } = await controller.tick();
  assert.equal(decision.charge, false);
  await controller.disable();
  assert.deepEqual(inverter.writes, []);
  assert.equal(inverter.holding.get(207), 25);
});

test("changed targets or reserve cause refusal; no silent correction", async () => {
  for (const [register, value] of [
    [2504, 250],
    [2505, 1000],
    [3005, 500],
    [3036, 300],
    [2500, 1],
  ]) {
    const inverter = new Inverter();
    inverter.holding.set(register, value);
    await assert.rejects(new BatteryController(inverter, options).tick());
    assert.deepEqual(inverter.writes, []);
  }
});

test("read-only diagnostics still show measurements when control settings differ", async () => {
  const inverter = new Inverter(83);
  inverter.holding.set(2505, 900);
  const controller = new BatteryController(inverter, {
    ...options,
    writesEnabled: false,
  });
  await assert.rejects(controller.snapshot(), /verified BSE20KH3/);
  const snapshot = await controller.snapshot(false);
  assert.equal(snapshot.soc, 83);
  assert.equal(snapshot.acTargetRaw, 900);
  assert.deepEqual(await controller.settings(), {
    maximumSoc: 100,
    reserveSoc: 50,
    rawHolding: { 3005: 1000, 3022: 0, 3023: 0, 3036: 500 },
  });
  assert.deepEqual(inverter.writes, []);
});

test("does not mistake an accepted write for a successfully changed setting", async () => {
  const inverter = new Inverter(89, 25);
  inverter.ignoreWrites = true;
  await assert.rejects(
    new BatteryController(inverter, options).disable(),
    /readback mismatch/,
  );
});

test("saved policy evidence preserves individual raw words using one existing block read", async () => {
  const inverter = new Inverter();
  inverter.holding.set(3022, 65535);
  inverter.holding.set(3023, 1);
  const requests = [];
  const controller = new BatteryController(
    {
      command: async (hex) => {
        const parsed = parseFrame(hex);
        requests.push({
          fn: parsed[1],
          address: parsed.readUInt16BE(2),
          count: parsed.readUInt16BE(4),
        });
        return inverter.command(hex);
      },
    },
    { ...options, writesEnabled: false },
  );
  assert.deepEqual((await controller.settings()).rawHolding, {
    3005: 1000,
    3022: 65535,
    3023: 1,
    3036: 500,
  });
  assert.deepEqual(requests, [{ fn: 3, address: 3005, count: 32 }]);
  assert.deepEqual(inverter.writes, []);
});

test("disabling preserves unrelated flag bits, while enabling refuses unexpected bits", async () => {
  const inverter = new Inverter(89, 25);
  inverter.holding.set(206, 0x8000);
  const controller = new BatteryController(inverter, options);
  await controller.disable();
  assert.equal(inverter.holding.get(206), 0x8000);
  assert.equal(inverter.holding.get(207), 9);
  await assert.rejects(controller.setAc(true), /changed flags/);
});

test("shutdown request prevents enabling charging", async () => {
  const inverter = new Inverter();
  await assert.rejects(
    new BatteryController(inverter, {
      ...options,
      isStopping: () => true,
    }).setAc(true),
  );
  assert.deepEqual(inverter.writes, []);
});

test("detects reserve changes after an earlier successful cycle", async () => {
  const inverter = new Inverter(89, 9);
  const controller = new BatteryController(inverter, options);
  await controller.tick();
  inverter.holding.set(3036, 300);
  await assert.rejects(controller.tick(), /reserve 50%/);
  assert.deepEqual(inverter.writes, []);
});

test("clears charging permission during grid loss without changing EPS permission", async () => {
  const inverter = new Inverter(30, 25);
  for (const register of [507, 508, 509]) inverter.input.set(register, 0);
  await new BatteryController(inverter, options).tick();
  assert.equal(inverter.holding.get(207), 9);
  assert.deepEqual(inverter.writes, [{ address: 206, values: [0, 9] }]);
});

test("write intent must persist before any inverter mutation", async () => {
  const inverter = new Inverter(30, 9);
  const controller = new BatteryController(inverter, {
    ...options,
    writeAudit: {
      prepare: async () => {
        throw new Error("Journal unavailable");
      },
    },
  });
  await assert.rejects(controller.setAc(true), /Journal unavailable/);
  assert.equal(inverter.writes.length, 0);
  assert.equal(inverter.holding.get(207), 9);
});

test("acknowledgment persistence failure does not skip physical readback", async () => {
  const inverter = new Inverter(30, 9);
  const stages = [];
  const controller = new BatteryController(inverter, {
    ...options,
    writeAudit: {
      prepare: async () => {
        stages.push("prepared");
        return "fixture-write";
      },
      acknowledge: async () => {
        throw new Error("Temporary database failure");
      },
      verify: async () => {
        assert.equal(inverter.holding.get(207), 25);
        stages.push("verified");
      },
      uncertain: async () => {
        stages.push("uncertain");
      },
    },
  });
  assert.equal(await controller.setAc(true), 25);
  assert.deepEqual(stages, ["prepared", "verified"]);
});

test("readback mismatch records uncertainty while keeping the original failure", async () => {
  const inverter = new Inverter(30, 9);
  inverter.ignoreWrites = true;
  const stages = [];
  const controller = new BatteryController(inverter, {
    ...options,
    writeAudit: {
      prepare: async () => {
        stages.push("prepared");
        return "fixture-write";
      },
      acknowledge: async () => {
        stages.push("acknowledged");
      },
      verify: async () => {
        stages.push("verified");
      },
      uncertain: async () => {
        stages.push("uncertain");
        throw new Error("Audit storage unavailable");
      },
    },
  });
  await assert.rejects(controller.setAc(true), /readback mismatch/);
  assert.deepEqual(stages, ["prepared", "acknowledged", "uncertain"]);
});

test("native charging near the target does not introduce a timed AC window", async () => {
  assert.equal(
    decide({ ...base, batteryW: -1945, gridW: 3200 }).reason,
    "native_charging",
  );
  assert.equal(
    decide({ ...base, flags: 25, batteryW: -1945, gridW: 3200 }).charge,
    true,
  );
  const inverter = new Inverter(40, 9);
  inverter.input.set(2007, 65535);
  inverter.input.set(2008, 65536 - 1945);
  const controller = new BatteryController(inverter, options);
  assert.equal((await controller.tick()).decision.reason, "native_charging");
  assert.deepEqual(inverter.writes, []);
});
