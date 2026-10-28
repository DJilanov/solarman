import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import {
  validTelegramChat,
  validTelegramToken,
} from "./notification-secrets.mjs";

export class WatchdogError extends Error {
  /** @param {string} code */
  constructor(code) {
    super(code);
    this.code = code;
  }
}

/** @typedef {{version:1,url:string,originHost:string,originPort:number,label:string,language:'en'|'bg',delivery:null|{botToken:string,chatId:string,enabled:boolean}}} WatchdogConfig */

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
      if (
        !d ||
        !validTelegramToken(d.botToken) ||
        !validTelegramChat(d.chatId) ||
        typeof d.enabled !== "boolean"
      )
        throw new Error();
      delivery = { botToken: d.botToken, chatId: d.chatId, enabled: d.enabled };
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

/** @param {WatchdogConfig} config @returns {{target:string,destination:string|null}} */
export function watchdogBindings(config) {
  const hash = (value) =>
    createHash("sha256").update(JSON.stringify(value)).digest("hex");
  return {
    target: hash([config.url, config.originHost, config.originPort]),
    destination: config.delivery
      ? hash([
          config.delivery.botToken,
          config.delivery.chatId,
          config.language,
          config.label,
        ])
      : null,
  };
}
