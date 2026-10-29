import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import {
  validTelegramChat,
  validTelegramToken,
} from "./notification-secrets.mjs";
import {
  normalizePushSubscription,
  webPushConfiguration,
} from "./web-push.mjs";

export class WatchdogError extends Error {
  /** @param {string} code */
  constructor(code) {
    super(code);
    this.code = code;
  }
}

/** @typedef {{kind:'webpush',subscription:import('./web-push.mjs').WebPushSubscription,vapid:import('./web-push.mjs').WebPushConfiguration,permission:{url:string,token:string},enabled:boolean}} WatchdogPushDelivery */
/** @typedef {{version:1,url:string,originHost:string,originPort:number,label:string,language:'en'|'bg',delivery:null|{botToken:string,chatId:string,enabled:boolean}|WatchdogPushDelivery}} WatchdogConfig */

/** @param {unknown} value @returns {WatchdogConfig} */
export function watchdogConfig(value) {
  try {
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      value.version !== 1
    )
      throw new Error();
    const url = new URL(value.url);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (
      (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/healthz" ||
      url.href !== value.url ||
      url.href.length > 2048
    )
      throw new Error();
    if (
      !isIP(value.originHost) ||
      !Number.isInteger(value.originPort) ||
      value.originPort < 1 ||
      value.originPort > 65535
    )
      throw new Error();
    if (
      typeof value.label !== "string" ||
      value.label.length < 1 ||
      value.label.length > 120 ||
      /[\u0000-\u001f\u007f]/.test(value.label) ||
      !["en", "bg"].includes(value.language)
    )
      throw new Error();
    let delivery = null;
    if (value.delivery !== null) {
      const d = value.delivery;
      if (d?.kind === "webpush") {
        const permission = new URL(d.permission?.url);
        if (
          typeof d.enabled !== "boolean" ||
          permission.origin !== url.origin ||
          permission.search ||
          permission.hash ||
          permission.username ||
          permission.password ||
          !/^\/api\/notifications\/push\/watchdog\/[a-f0-9-]{36}$/.test(
            permission.pathname,
          ) ||
          !/^[a-f0-9]{64}$/.test(d.permission?.token) ||
          d.vapid?.subject !== url.origin
        )
          throw new Error();
        const vapid = webPushConfiguration({
          WEB_PUSH_PUBLIC_KEY: d.vapid.publicKey,
          WEB_PUSH_PRIVATE_KEY: d.vapid.privateKey,
          PUBLIC_URL: d.vapid.subject,
        });
        if (!vapid) throw new Error();
        delivery = {
          kind: "webpush",
          subscription: normalizePushSubscription(d.subscription),
          vapid,
          permission: { url: permission.href, token: d.permission.token },
          enabled: d.enabled,
        };
      } else {
        if (
          !d ||
          (d.kind !== undefined && d.kind !== "telegram") ||
          !validTelegramToken(d.botToken) ||
          !validTelegramChat(d.chatId) ||
          typeof d.enabled !== "boolean"
        )
          throw new Error();
        delivery = {
          botToken: d.botToken,
          chatId: d.chatId,
          enabled: d.enabled,
        };
      }
    }
    return {
      version: 1,
      url: url.href,
      originHost: value.originHost,
      originPort: value.originPort,
      label: value.label,
      language: value.language,
      delivery,
    };
  } catch {
    throw new WatchdogError("configuration_invalid");
  }
}

/** @param {string} file @param {number} maximum @returns {Promise<unknown>} */
export async function readPrivateJson(file, maximum) {
  let handle;
  try {
    handle = await open(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const info = await handle.stat();
    if (
      !info.isFile() ||
      info.size > maximum ||
      ![0, process.getuid()].includes(info.uid) ||
      (info.mode & 0o027) !== 0 ||
      ((info.mode & 0o040) !== 0 &&
        info.gid !== process.getgid() &&
        process.getuid() !== 0)
    )
      throw new WatchdogError("private_file_permissions");
    const bytes = await handle.readFile();
    if (bytes.length > maximum)
      throw new WatchdogError("private_file_too_large");
    try {
      return JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new WatchdogError("private_file_invalid");
    }
  } finally {
    await handle?.close();
  }
}

/** @param {string} file @returns {Promise<WatchdogConfig>} */
export async function readWatchdogConfig(file) {
  return watchdogConfig(await readPrivateJson(file, 16384));
}

/** @param {WatchdogConfig} config @param {string} host @param {{address:string}[]} addresses @returns {void} */
export function assertWatchdogInstallationTarget(config, host, addresses) {
  const url = new URL(config.url);
  const loopback = (address) =>
    ["localhost", "::1", "[::1]", "0.0.0.0", "::"].includes(address) ||
    address.startsWith("127.") ||
    address.endsWith(".localhost");
  if (
    url.protocol !== "https:" ||
    loopback(url.hostname) ||
    loopback(config.originHost) ||
    host.toLowerCase() === url.hostname ||
    addresses.length === 0 ||
    addresses.some(
      (item) => item.address === config.originHost || loopback(item.address),
    )
  )
    throw new WatchdogError("installation_target_invalid");
}

/** @param {WatchdogConfig} config @returns {{target:string,destination:string|null}} */
export function watchdogBindings(config) {
  const hash = (value) =>
    createHash("sha256").update(JSON.stringify(value)).digest("hex");
  return {
    target: hash([config.url, config.originHost, config.originPort]),
    destination: config.delivery
      ? "kind" in config.delivery && config.delivery.kind === "webpush"
        ? hash([
            config.delivery.kind,
            config.delivery.subscription,
            config.delivery.vapid,
            config.delivery.permission,
            config.language,
            config.label,
          ])
        : hash([
            config.delivery.botToken,
            config.delivery.chatId,
            config.language,
            config.label,
          ])
      : null,
  };
}
