import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { decodeReply, parseFrame } from "./modbus.mjs";

const CALLBACK_PREFIX = "/solarman/callback/";

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** @param {unknown} value @returns {number} */
function timestamp(value) {
  const number =
    typeof value === "number" || typeof value === "string"
      ? Number(value)
      : NaN;
  if (!Number.isFinite(number) || number <= 0)
    throw new Error("Invalid callback timestamp");
  return number < 100_000_000_000 ? number * 1000 : number;
}

/** @param {unknown} code @returns {string} */
function safeCode(code) {
  return /^[0-9]{1,12}$/.test(String(code)) ? String(code) : "unspecified";
}

/** @param {import('node:http').IncomingMessage} request @returns {Promise<unknown>} */
async function readJson(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 8192) throw new Error("Callback body too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export class SolarmanClient {
  /**
   * @param {object} config
   * @param {string} config.appId
   * @param {string} config.appSecret
   * @param {string} config.email
   * @param {string} config.passwordSha256
   * @param {string} config.deviceSN
   * @param {string} config.baseUrl
   * @param {string} config.callbackOrigin
   * @param {number} config.commandTimeoutMs
   * @param {{ minGapMs?: number, health?: () => object, onRequest?: (kind: string) => Promise<void>, callbackPrefix?: string, beforeRequest?: () => Promise<void> }} [options]
   */
  constructor(config, options = {}) {
    this.config = config;
    this.minGapMs = options.minGapMs ?? 1500;
    this.health = options.health ?? (() => ({ healthy: true }));
    this.onRequest = options.onRequest ?? (async () => {});
    this.callbackPrefix = options.callbackPrefix ?? CALLBACK_PREFIX;
    this.beforeRequest = options.beforeRequest ?? (async () => {});
    this.pending = new Map();
    this.completed = new Map();
    this.tail = Promise.resolve();
    this.lastRequestAt = 0;
    this.token = null;
    this.tokenExpiresAt = 0;
    this.server = createServer(
      { requestTimeout: 10_000, headersTimeout: 5_000 },
      (request, response) => {
        this.handleHttp(request, response).catch(() => {
          if (!response.headersSent) response.writeHead(400);
          response.end("INVALID_CALLBACK");
        });
      },
    );
    this.server.maxHeadersCount = 30;
  }

  /** @param {number} port @param {string} host @returns {Promise<void>} */
  async listen(port, host) {
    await new Promise((resolve, reject) => {
      const onError = (error) => reject(error);
      this.server.once("error", onError);
      this.server.listen(port, host, () => {
        this.server.removeListener("error", onError);
        resolve();
      });
    });
  }

  /** @returns {Promise<void>} */
  async close() {
    for (const pending of this.pending.values())
      pending.finish(new Error("Service shutting down"));
    this.completed.clear();
    if (!this.server.listening) return;
    await new Promise((resolve, reject) => {
      this.server.close((error) => (error ? reject(error) : resolve()));
      this.server.closeIdleConnections();
    });
  }

  /** @param {import('node:http').IncomingMessage} request @param {import('node:http').ServerResponse} response @returns {Promise<void>} */
  async handleHttp(request, response) {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    if (request.method === "GET" && path === "/healthz") {
      const health = this.health();
      response.writeHead(health.healthy ? 200 : 503, {
        "content-type": "application/json",
      });
      response.end(JSON.stringify(health));
      return;
    }
    if (request.method !== "POST" || !path.startsWith(this.callbackPrefix)) {
      response.writeHead(404);
      response.end();
      return;
    }
    const key = path.slice(this.callbackPrefix.length);
    if (!/^[a-f0-9]{64}$/.test(key)) {
      response.writeHead(404);
      response.end();
      return;
    }
    const now = Date.now();
    for (const [token, expiry] of this.completed)
      if (expiry < now) this.completed.delete(token);
    if (this.completed.has(key)) {
      response.end("SUCCESS");
      return;
    }
    const pending = this.pending.get(key);
    if (!pending) {
      response.writeHead(404);
      response.end();
      return;
    }
    const body = await readJson(request);
    if (
      !isObject(body) ||
      body.deviceSn !== this.config.deviceSN ||
      typeof body.content !== "string" ||
      body.content.replace(/\s/g, "").toUpperCase() !== pending.command
    ) {
      response.writeHead(403);
      response.end("INVALID_CALLBACK");
      return;
    }
    const createdAt = timestamp(body.createTime);
    const updatedAt = timestamp(body.updateTime);
    if (
      createdAt < pending.sentAt - 30_000 ||
      updatedAt < createdAt ||
      updatedAt > now + 30_000 ||
      now - updatedAt > 90_000
    ) {
      response.writeHead(400);
      response.end("STALE_CALLBACK");
      return;
    }
    // HTTP acceptance is not a device acknowledgment; validate the raw RTU reply as well.
    let result;
    try {
      if (body.success !== true)
        throw new Error(
          `Device command failed (code ${safeCode(body.errorCode)})`,
        );
      if (typeof body.ack !== "string")
        throw new Error("Missing device acknowledgment");
      decodeReply(pending.command, body.ack);
      result = { ack: body.ack, orderId: body.orderId };
    } catch (error) {
      result = error;
    }
    pending.finish(result);
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("SUCCESS");
  }

  /** @param {string} path @param {object} body @param {string | null} [token] @param {boolean} [requestReserved] @returns {Promise<Record<string, unknown>>} */
  async post(path, body, token = null, requestReserved = false) {
    const url = new URL(path, this.config.baseUrl);
    url.searchParams.set("language", "en");
    if (path === "/account/v1.0/token")
      url.searchParams.set("appId", this.config.appId);
    if (!requestReserved) await this.beforeRequest();
    await this.onRequest(
      path === "/account/v1.0/token"
        ? "token"
        : path === "/device/v1.0/customControl"
          ? "command"
          : "read",
    );
    let response;
    try {
      response = await fetch(url, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      });
    } catch {
      throw new Error("SOLARMAN HTTP request failed or timed out");
    }
    if (!response.ok) {
      if (response.status === 401) this.token = null;
      throw new Error(`SOLARMAN HTTP status ${response.status}`);
    }
    let result;
    try {
      result = await response.json();
    } catch {
      throw new Error("Invalid SOLARMAN JSON response");
    }
    if (!isObject(result) || result.success !== true) {
      if (
        isObject(result) &&
        ["2101017", "2101019"].includes(String(result.code))
      )
        this.token = null;
      throw new Error(
        `SOLARMAN rejected request (code ${safeCode(isObject(result) ? result.code : null)})`,
      );
    }
    return result;
  }

  /** @returns {Promise<string>} */
  async accessToken() {
    if (this.token && Date.now() < this.tokenExpiresAt) return this.token;
    const result = await this.post("/account/v1.0/token", {
      appSecret: this.config.appSecret,
      email: this.config.email,
      password: this.config.passwordSha256,
    });
    const expires = Number(result.expires_in);
    if (
      typeof result.access_token !== "string" ||
      !result.access_token ||
      !Number.isFinite(expires) ||
      expires < 120
    ) {
      throw new Error("Invalid SOLARMAN token response");
    }
    this.token = result.access_token;
    this.tokenExpiresAt = Date.now() + (expires - 60) * 1000;
    return this.token;
  }

  /** @param {string} command @returns {Promise<string>} */
  command(command) {
    if (!this.config.deviceSN)
      return Promise.reject(
        new Error("Choose an inverter before sending device commands"),
      );
    const normalized = parseFrame(command).toString("hex").toUpperCase();
    const result = this.tail.then(() => this.send(normalized));
    // A failed command must not prevent a subsequent attempt to disable AC charging.
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** @param {string} command @returns {Promise<string>} */
  async send(command) {
    await delay(Math.max(0, this.minGapMs - (Date.now() - this.lastRequestAt)));
    const token = await this.accessToken();
    await this.beforeRequest();
    const key = randomBytes(32).toString("hex");
    const sentAt = Date.now();
    let finish;
    const promise = new Promise((resolve) => {
      finish = resolve;
    });
    const timer = setTimeout(() => {
      pending.finish(
        new Error(
          "Device acknowledgment timed out; command outcome is unknown",
        ),
      );
    }, this.config.commandTimeoutMs + 10_000);
    const pending = {
      command,
      sentAt,
      finish: (result) => {
        clearTimeout(timer);
        this.pending.delete(key);
        this.completed.set(key, Date.now() + 600_000);
        finish(result);
      },
    };
    this.pending.set(key, pending);
    this.lastRequestAt = sentAt;
    try {
      const result = await this.post(
        "/device/v1.0/customControl",
        {
          deviceSN: this.config.deviceSN,
          content: command,
          callBackUrl: `${this.config.callbackOrigin}${this.callbackPrefix}${key}`,
          timeoutSeconds: Math.floor(this.config.commandTimeoutMs / 1000),
        },
        token,
        true,
      );
      const callback = await promise;
      if (callback instanceof Error) throw callback;
      if (
        result.orderId !== undefined &&
        String(result.orderId) !== String(callback.orderId)
      ) {
        throw new Error("Command order ID mismatch");
      }
      return callback.ack;
    } finally {
      clearTimeout(timer);
      this.pending.delete(key);
    }
  }

  /** @param {string} path @param {object} body @returns {Promise<Record<string, unknown>>} */
  api(path, body) {
    if (
      ![
        "/station/v1.0/list",
        "/station/v1.0/device",
        "/device/v1.0/currentData",
      ].includes(path)
    ) {
      return Promise.reject(new Error("Unsupported provider read endpoint"));
    }
    const result = this.tail.then(async () => {
      return this.post(path, body, await this.accessToken());
    });
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
