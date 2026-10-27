import test from "node:test";
import assert from "node:assert/strict";
import {
  readCommand,
  writeCommand,
  decodeReply,
  signed32,
  signed16,
  unsigned32,
  parseFrame,
  frame,
} from "../src/modbus.mjs";

test("reproduces commands already tested on the real inverter", () => {
  assert.equal(readCommand(3, 206, 2), "010300CE0002A5F4");
  assert.equal(readCommand(3, 3036, 1), "01030BDC000147D4");
  assert.equal(readCommand(4, 2000, 9), "010407D000093081");
  assert.equal(writeCommand(206, [0, 25]), "011000CE00020400000019BFB9");
  assert.equal(writeCommand(206, [0, 9]), "011000CE00020400000009BE75");
});

test("decodes actual settings and live battery replies", () => {
  assert.equal(
    unsigned32(decodeReply(readCommand(3, 206, 2), "010304000000093A35")),
    9,
  );
  assert.deepEqual(
    decodeReply(readCommand(3, 2504, 2), "010304006401F4BBFB"),
    [100, 500],
  );
  assert.deepEqual(decodeReply(readCommand(3, 3036, 1), "01030201F4B853"), [
    500,
  ]);
  const battery = decodeReply(
    readCommand(4, 2000, 9),
    "010412000500AA00590064086002440858000004D2469E",
  );
  assert.equal(battery[0], 5);
  assert.equal(battery[2], 89);
  assert.equal(signed32(battery, 7), 1234);
  assert.equal(signed16(battery[1]) / 10, 17);
  const charging = decodeReply(
    readCommand(4, 2000, 9),
    "010412000400C800530064086AFFE20865FFFFFFC03586",
  );
  assert.equal(signed32(charging, 7), -64);
  assert.equal(signed16(charging[5]) / 100, -0.3);
});

test("write acknowledgment cannot distinguish enable from disable", () => {
  for (const flags of [9, 25])
    assert.deepEqual(
      decodeReply(writeCommand(206, [0, flags]), "011000CE00022037"),
      [],
    );
});

test("rejects corrupt frames, exceptions, incorrect lengths and wrong functions", () => {
  assert.throws(() => parseFrame("010304000000093A34"), /CRC/);
  assert.throws(() => parseFrame("0103xx"), /hex/);
  assert.throws(
    () => decodeReply(readCommand(3, 206, 2), "01030201F4B853"),
    /count/,
  );
  assert.throws(
    () => decodeReply(readCommand(4, 2000, 9), "01030201F4B853"),
    /function/,
  );
  assert.throws(() => readCommand(3, 65535, 2), /Invalid/);
  assert.throws(() => writeCommand(206, [-1]), /Invalid/);
  assert.throws(
    () => decodeReply(readCommand(3, 206, 2), frame(Buffer.from([1, 0x83, 3]))),
    /exception 3/,
  );
});
