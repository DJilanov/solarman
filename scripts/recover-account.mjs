import { stdin, stdout } from "node:process";
import { Writable } from "node:stream";
import { createInterface } from "node:readline/promises";
import { dashboardConfig } from "../src/dashboard-config.mjs";
import { createPool } from "../src/database.mjs";
import { AccountRecovery } from "../src/account-recovery.mjs";
import { SecurityError } from "../src/account-security.mjs";

/** @param {string} label @returns {Promise<string>} */
async function hiddenQuestion(label) {
  stdout.write(label);
  const sink = new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });
  const reader = createInterface({
    input: stdin,
    output: sink,
    terminal: true,
  });
  const controller = new AbortController();
  reader.once("SIGINT", () => controller.abort());
  reader.once("close", () => controller.abort());
  try {
    return await reader.question("", { signal: controller.signal });
  } finally {
    reader.close();
    stdout.write("\n");
  }
}

async function main() {
  if (!stdin.isTTY || !stdout.isTTY)
    throw new SecurityError(
      400,
      "Run account recovery in an interactive terminal (ssh -t).",
    );
  if (
    process.argv.length !== 4 ||
    process.argv[2] !== "--email" ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(process.argv[3])
  )
    throw new SecurityError(
      400,
      "Usage: node scripts/recover-account.mjs --email account@example.com",
    );
  const email = process.argv[3].toLowerCase();
  const pool = createPool(dashboardConfig(process.env).database);
  try {
    if (
      !(await pool.query("SELECT 1 FROM users WHERE lower(email)=$1", [email]))
        .rowCount
    )
      throw new SecurityError(404, "Account not found");
    const password = await hiddenQuestion("New dashboard password: ");
    const confirm = await hiddenQuestion("Confirm new password: ");
    if (password !== confirm)
      throw new SecurityError(400, "Passwords do not match");
    await new AccountRecovery(pool).operatorReset(email, password);
    stdout.write(
      "Account recovered. All browser sessions and recovery credentials have been invalidated.\n",
    );
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(
    error instanceof SecurityError
      ? error.message
      : error?.name === "AbortError"
        ? "Account recovery cancelled."
        : "Account recovery failed. Check the database configuration.",
  );
  process.exitCode = 1;
});
