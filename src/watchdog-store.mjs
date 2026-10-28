import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { readPrivateJson, WatchdogError } from "./watchdog-config.mjs";
import {
  emptyWatchdogState,
  validateWatchdogState,
} from "./watchdog-state.mjs";

/** @param {string} directory @returns {Promise<void>} */
export async function watchdogDirectory(directory) {
  if (!path.isAbsolute(directory))
    throw new WatchdogError("state_directory_invalid");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid() ||
    (info.mode & 0o077) !== 0
  )
    throw new WatchdogError("state_directory_permissions");
}

/** @param {string} directory @returns {Promise<object>} */
export async function readWatchdogState(directory) {
  await watchdogDirectory(directory);
  try {
    const state = await readPrivateJson(
      path.join(directory, "state.json"),
      1048576,
    );
    validateWatchdogState(state);
    return state;
  } catch (error) {
    if (error.code === "ENOENT") return emptyWatchdogState();
    throw error;
  }
}

/** @param {string} directory @param {object} state @returns {Promise<void>} */
export async function writeWatchdogState(directory, state) {
  validateWatchdogState(state);
  await watchdogDirectory(directory);
  const temporary = path.join(directory, randomUUID() + ".tmp");
  let handle;
  try {
    handle = await open(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    const text = JSON.stringify(state) + "\n";
    if (Buffer.byteLength(text) > 1048576)
      throw new WatchdogError("state_too_large");
    await handle.writeFile(text);
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, path.join(directory, "state.json"));
    const parent = await open(
      directory,
      constants.O_RDONLY | constants.O_DIRECTORY,
    );
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  } finally {
    await handle?.close();
    await rm(temporary, { force: true });
  }
}
