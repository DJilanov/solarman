/** @param {Uint8Array} bytes @returns {number} */
export function crc16(bytes) {
  let crc = 0xffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ (crc & 1 ? 0xa001 : 0);
  }
  return crc;
}

/** @param {Buffer} payload @returns {string} */
export function frame(payload) {
  const result = Buffer.alloc(payload.length + 2);
  payload.copy(result);
  result.writeUInt16LE(crc16(payload), payload.length);
  return result.toString("hex").toUpperCase();
}

/** @param {number} fn @param {number} address @param {number} count @returns {string} */
export function readCommand(fn, address, count) {
  if (
    ![3, 4].includes(fn) ||
    !Number.isInteger(address) ||
    address < 0 ||
    address > 65535 ||
    !Number.isInteger(count) ||
    count < 1 ||
    count > 125 ||
    address + count > 65536
  ) {
    throw new Error("Invalid Modbus read request");
  }
  const payload = Buffer.alloc(6);
  payload[0] = 1;
  payload[1] = fn;
  payload.writeUInt16BE(address, 2);
  payload.writeUInt16BE(count, 4);
  return frame(payload);
}

/** @param {number} address @param {number[]} values @returns {string} */
export function writeCommand(address, values) {
  if (
    !Number.isInteger(address) ||
    address < 0 ||
    values.length < 1 ||
    values.length > 123 ||
    address + values.length > 65536 ||
    values.some((v) => !Number.isInteger(v) || v < 0 || v > 65535)
  ) {
    throw new Error("Invalid Modbus write request");
  }
  const payload = Buffer.alloc(7 + values.length * 2);
  payload[0] = 1;
  payload[1] = 16;
  payload.writeUInt16BE(address, 2);
  payload.writeUInt16BE(values.length, 4);
  payload[6] = values.length * 2;
  values.forEach((value, index) => payload.writeUInt16BE(value, 7 + index * 2));
  return frame(payload);
}

/** @param {string} hex @returns {Buffer} */
export function parseFrame(hex) {
  if (typeof hex !== "string") throw new Error("Missing Modbus frame");
  const normalized = hex.replace(/\s/g, "");
  if (
    !/^[a-f0-9]+$/i.test(normalized) ||
    normalized.length % 2 ||
    normalized.length > 520
  ) {
    throw new Error("Invalid Modbus hex");
  }
  const bytes = Buffer.from(normalized, "hex");
  if (
    bytes.length < 5 ||
    bytes[0] !== 1 ||
    crc16(bytes.subarray(0, -2)) !== bytes.readUInt16LE(bytes.length - 2)
  ) {
    throw new Error("Invalid Modbus address, length or CRC");
  }
  return bytes;
}

/** @param {string} request @param {string} reply @returns {number[]} */
export function decodeReply(request, reply) {
  const sent = parseFrame(request);
  const received = parseFrame(reply);
  if (received[1] === (sent[1] | 0x80) && received.length === 5) {
    throw new Error(`Modbus exception ${received[2]}`);
  }
  if (received[1] !== sent[1]) throw new Error("Modbus function mismatch");
  if ([3, 4].includes(sent[1])) {
    const count = sent.readUInt16BE(4);
    if (received[2] !== count * 2 || received.length !== count * 2 + 5) {
      throw new Error("Modbus register count mismatch");
    }
    return Array.from({ length: count }, (_, i) =>
      received.readUInt16BE(3 + 2 * i),
    );
  }
  if (
    sent[1] !== 16 ||
    received.length !== 8 ||
    !received.subarray(0, 6).equals(sent.subarray(0, 6))
  ) {
    throw new Error("Modbus write acknowledgment mismatch");
  }
  return [];
}

/** @param {number[]} registers @param {number} offset @returns {number} */
export function unsigned32(registers, offset = 0) {
  return registers[offset] * 65536 + registers[offset + 1];
}

/** @param {number[]} registers @param {number} offset @returns {number} */
export function signed32(registers, offset = 0) {
  const value = unsigned32(registers, offset);
  return value >= 0x80000000 ? value - 0x100000000 : value;
}

/** @param {number} value @returns {number} */
export function signed16(value) {
  return value >= 32768 ? value - 65536 : value;
}

/** @param {number} flags @returns {number[]} */
export function flagRegisters(flags) {
  return [Math.floor(flags / 65536), flags & 0xffff];
}
