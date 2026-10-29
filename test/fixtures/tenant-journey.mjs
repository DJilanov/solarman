import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { frame, parseFrame } from "../../src/modbus.mjs";
import { providerPayload } from "./provider.mjs";

/** @typedef {{origin:string,device:string,providerEmail:string,providerPassword:string,appId:string,appSecret:string,botToken:string,chatId:string}} JourneyConfig */
/** @typedef {{soc:number,pvW:number,loadW:number,gridW:number,batteryW:number}} JourneyTelemetry */

export class TenantJourneyCloud {
  /** @param {JourneyConfig} config @param {typeof fetch} transport */
  constructor(config, transport) {
    this.config = config;
    this.transport = transport;
    this.collectedAt = Date.now() - 60000;
    this.online = true;
    /** @type {JourneyTelemetry} */
    this.telemetry = { soc: 30, pvW: 0, loadW: 1200, gridW: 1200, batteryW: 0 };
    this.holding = new Map([
      [206, 0],
      [207, 9],
      [2500, 0],
      [2504, 100],
      [2505, 500],
      [2509, 0],
      [2510, 0x173b],
      [3005, 1000],
      [3022, 0],
      [3023, 100],
      [3036, 500],
    ]);
    /** @type {string[]} */
    this.requests = [];
    /** @type {{address:number,values:number[]}[]} */
    this.writes = [];
    /** @type {number[]} */
    this.callbacks = [];
    /** @type {{chatId:string,text:string}[]} */
    this.deliveries = [];
    this.rejectedNetworkAttempts = 0;
    this.readFailuresRemaining = 0;
    this.readFailuresSent = 0;
  }

  /** @param {Partial<JourneyTelemetry>} patch @returns {void} */
  advance(patch) {
    Object.assign(this.telemetry, patch);
    this.collectedAt += 1000;
  }

  /** @param {string} command @returns {string} */
  reply(command) {
    const request = parseFrame(command);
    const fn = request[1];
    const address = request.readUInt16BE(2);
    const count = request.readUInt16BE(4);
    assert.equal(request[0], 1);
    if (fn === 16) {
      assert.ok(
        (address === 206 && count === 2) || (address === 2509 && count === 8) || ([2500,2505].includes(address) && count === 1),
        "The rehearsal only permits the application's named schedule writes",
      );
      const values = Array.from({ length: count }, (_, index) =>
        request.readUInt16BE(7 + index * 2),
      );
      this.writes.push({ address, values });
      values.forEach((value, index) =>
        this.holding.set(address + index, value),
      );
      return frame(request.subarray(0, 6));
    }
    assert.ok(fn === 3 || fn === 4);
    assert.ok(count > 0 && count <= 125);
    const input = new Map([
      [7, 0],
      [8, 20000],
      [2000, 6],
      [2001, 170],
      [2002, this.telemetry.soc],
      [2003, 100],
      [2004, 2144],
      [507, 2300],
      [508, 2300],
      [509, 2300],
    ]);
    /** @param {number} at @param {number} value @returns {void} */
    const putPower = (at, value) => {
      const raw = value >>> 0;
      input.set(at, raw >>> 16);
      input.set(at + 1, raw & 65535);
    };
    putPower(2007, this.telemetry.batteryW);
    putPower(535, this.telemetry.gridW);
    putPower(547, this.telemetry.loadW);
    putPower(553, this.telemetry.pvW);
    const registers = fn === 3 ? this.holding : input;
    const response = Buffer.alloc(3 + count * 2);
    response[0] = 1;
    response[1] = fn;
    response[2] = count * 2;
    for (let index = 0; index < count; index++)
      response.writeUInt16BE(
        registers.get(address + index) ?? 0,
        3 + index * 2,
      );
    return frame(response);
  }

  /** @param {Parameters<typeof fetch>[0]} input @param {RequestInit} [init] @returns {Promise<Response>} */
  async fetch(input, init) {
    const url = new URL(
      typeof input === "string" || input instanceof URL ? input : input.url,
    );
    if (url.origin === this.config.origin)
      return this.transport(input, { ...init, redirect: "error" });
    if (
      ![
        "https://api.telegram.org",
        "https://globalapi.solarmanpv.com",
      ].includes(url.origin)
    ) {
      this.rejectedNetworkAttempts++;
      throw new Error("The rehearsal refuses external network access");
    }
    const body = JSON.parse(String(init?.body));
    assert.equal(init?.method, "POST");
    if (url.origin === "https://api.telegram.org") {
      assert.equal(
        url.pathname,
        "/bot" + this.config.botToken + "/sendMessage",
      );
      assert.equal(body.chat_id, this.config.chatId);
      this.deliveries.push({ chatId: body.chat_id, text: body.text });
      return Response.json({
        ok: true,
        result: {
          message_id: this.deliveries.length,
          chat: { id: Number(this.config.chatId) },
        },
      });
    }
    this.requests.push(url.pathname);
    if (url.pathname === "/account/v1.0/token") {
      assert.equal(url.searchParams.get("appId"), this.config.appId);
      assert.deepEqual(body, {
        email: this.config.providerEmail,
        appSecret: this.config.appSecret,
        password: createHash("sha256")
          .update(this.config.providerPassword)
          .digest("hex"),
      });
      return Response.json({
        success: true,
        access_token: "journey-provider-access-token",
        expires_in: 3600,
      });
    }
    assert.equal(
      new Headers(init?.headers).get("authorization"),
      "bearer journey-provider-access-token",
    );
    switch (url.pathname) {
      case "/account/v1.0/balance":
        return Response.json({ success: true, total: 200000 });
      case "/station/v1.0/list":
        return Response.json({
          success: true,
          total: 1,
          stationList: [{ id: 1, name: "Rehearsal home" }],
        });
      case "/station/v1.0/device":
        assert.equal(body.stationId, 1);
        return Response.json({
          success: true,
          total: 1,
          deviceListItems: [
            { deviceType: "INVERTER", deviceSn: this.config.device },
          ],
        });
      case "/device/v1.0/currentData":
        assert.equal(body.deviceSn, this.config.device);
        return Response.json({
          success: true,
          ...providerPayload({
            device: this.config.device,
            collectedAt: this.collectedAt,
            state: this.online ? 1 : 2,
            values: {
              PVTP: String(this.telemetry.pvW),
              EP: String(this.telemetry.loadW),
              PG_Pt1: String(this.telemetry.gridW),
              B_P1: String(this.telemetry.batteryW),
              B_left_cap1: String(this.telemetry.soc),
              B_T1: "17.00",
            },
          }),
        });
      case "/device/v1.0/customControl": {
        assert.equal(body.deviceSN, this.config.device);
        const callback = new URL(body.callBackUrl);
        assert.equal(callback.origin, "https://journey.example.test");
        assert.match(
          callback.pathname,
          /^\/solarman\/callback\/[a-f0-9-]{36}\/[a-f0-9]{64}$/,
        );
        const orderId = this.callbacks.length + 1;
        const now = Date.now();
        const failedRead =
          [3, 4].includes(parseFrame(body.content)[1]) &&
          this.readFailuresRemaining > 0;
        if (failedRead) {
          this.readFailuresRemaining--;
          this.readFailuresSent++;
        }
        const delivered = await this.transport(
          new URL(callback.pathname, this.config.origin),
          {
            method: "POST",
            redirect: "error",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              deviceSn: this.config.device,
              content: body.content,
              createTime: now,
              updateTime: now,
              orderId,
              ...(failedRead
                ? { success: false, errorCode: "530" }
                : { success: true, ack: this.reply(body.content) }),
            }),
          },
        );
        this.callbacks.push(delivered.status);
        assert.equal(delivered.status, 200);
        assert.equal(await delivered.text(), "SUCCESS");
        return Response.json({ success: true, orderId });
      }
      default:
        this.rejectedNetworkAttempts++;
        throw new Error("Unexpected SOLARMAN request in the rehearsal");
    }
  }
}
