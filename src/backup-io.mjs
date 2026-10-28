import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { Transform } from "node:stream";

export const MAX_RESTORE_BYTES = 256 * 1024 * 1024;
export const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

export class BackupError extends Error {
  /** @param {string} code */
  constructor(code) {
    super(code);
    this.code = code;
  }
}

/** @param {string} file @param {object} value @param {number} [mode] @returns {Promise<void>} */
export async function atomicJson(file, value, mode = 0o600) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value) + "\n", {
    flag: "wx",
    mode,
  });
  await chmod(temporary, mode);
  await rename(temporary, file);
}

/** @param {string} file @returns {Promise<{bytes:number,sha256:string}>} */
export async function fingerprint(file) {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  return { bytes, sha256: hash.digest("hex") };
}

/** @param {string} binary @param {string[]} args @param {{env?: NodeJS.ProcessEnv, timeout?:number, allowedExitCodes?:number[]}} [options] @returns {{child:import('node:child_process').ChildProcessWithoutNullStreams,done:Promise<void>}} */
export function childProcess(
  binary,
  args,
  { env = process.env, timeout = 300000, allowedExitCodes = [0] } = {},
) {
  const child = spawn(binary, args, { env, stdio: ["pipe", "pipe", "pipe"] });
  child.stderr.resume();
  let timer;
  const done = new Promise((resolve, reject) => {
    child.once("error", () => reject(new BackupError("process_start_failed")));
    child.once("close", (code) =>
      allowedExitCodes.includes(code)
        ? resolve()
        : reject(new BackupError("process_failed")),
    );
    timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, timeout);
  }).finally(() => clearTimeout(timer));
  return { child, done };
}

/** @param {AsyncIterable<Buffer>} input @param {number} maximum @returns {Promise<Buffer>} */
export async function boundedBuffer(input, maximum) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of input) {
    bytes += chunk.length;
    if (bytes > maximum) throw new BackupError("payload_too_large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** @param {string} binary @param {string[]} args @param {Buffer} input @param {{env?:NodeJS.ProcessEnv,maximum?:number,allowedExitCodes?:number[]}} [options] @returns {Promise<Buffer>} */
export async function runBuffered(
  binary,
  args,
  input,
  { env = process.env, maximum = 1024 * 1024, allowedExitCodes = [0] } = {},
) {
  const process = childProcess(binary, args, { env, allowedExitCodes });
  try {
    const [, output] = await Promise.all([
      process.done,
      boundedBuffer(process.child.stdout, maximum),
      pipeline([input], process.child.stdin),
    ]);
    return output;
  } finally {
    process.child.kill("SIGKILL");
    await process.done.catch(() => {});
  }
}

/** @param {string} age @param {string} recipient @param {AsyncIterable<Buffer>} input @param {string} file @returns {Promise<number>} */
export async function encryptStream(age, recipient, input, file) {
  const process = childProcess(
    age,
    ["--encrypt", "--recipients-file", recipient],
    { timeout: 900000 },
  );
  const output = createWriteStream(file, { flags: "wx", mode: 0o600 });
  let bytes = 0;
  const counter = new Transform({
    transform(chunk, encoding, callback) {
      bytes += chunk.length;
      callback(null, chunk);
    },
  });
  try {
    await Promise.all([
      process.done,
      pipeline(input, counter, process.child.stdin),
      pipeline(process.child.stdout, output),
    ]);
    return bytes;
  } finally {
    process.child.kill("SIGKILL");
    await process.done.catch(() => {});
  }
}

/** @param {string} file @returns {Promise<object>} */
export async function sealedConfig(file) {
  const info = await stat(file);
  if (info.uid !== 0 || (info.mode & 0o022) !== 0)
    throw new BackupError("config_permissions");
  const config = JSON.parse(await readFile(file, "utf8"));
  if (
    config.database !== "solarman" ||
    !/^jilanov-solarman-backups-[a-f0-9]{8}$/.test(config.bucket) ||
    config.retentionDays !== 30 ||
    !/^([a-z]{2}-[a-z]+-\d)$/.test(config.region) ||
    !["appEnv", "awsEnv", "recipientFile", "age", "stateDirectory"].every(
      (key) => typeof config[key] === "string" && path.isAbsolute(config[key]),
    )
  )
    throw new BackupError("config_invalid");
  return config;
}

/** @param {string} value @returns {string} */
export function identifier(value) {
  return '"' + value.replaceAll('"', '""') + '"';
}

/** @param {import('pg').PoolClient} database @returns {Promise<object>} */
export async function inventory(database) {
  const tables = (
    await database.query(
      "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename",
    )
  ).rows.map((row) => row.tablename);
  const counts = new Map();
  for (const table of tables)
    counts.set(
      table,
      Number(
        (
          await database.query(
            `SELECT count(*)::text AS count FROM public.${identifier(table)}`,
          )
        ).rows[0].count,
      ),
    );
  const users = (
    await database.query("SELECT id,password_hash FROM users ORDER BY id")
  ).rows;
  const authHash = createHash("sha256")
    .update(JSON.stringify(users))
    .digest("hex");
  const migrations = (
    await database.query(
      "SELECT version FROM schema_migrations ORDER BY version",
    )
  ).rows.map((row) => row.version);
  return { counts: Object.fromEntries(counts), authHash, migrations };
}
