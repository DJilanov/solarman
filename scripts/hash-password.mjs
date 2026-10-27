import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { hashPassword } from "../src/auth.mjs";

if (!process.stdin.isTTY)
  throw new Error("Run this command in an interactive terminal");
process.stdout.write("Administrator password (hidden): ");
const silent = new Writable({
  write(_chunk, _encoding, callback) {
    callback();
  },
});
const prompt = createInterface({
  input: process.stdin,
  output: silent,
  terminal: true,
});
prompt.once("SIGINT", () => {
  prompt.close();
  process.exitCode = 130;
});
prompt.question("", async (password) => {
  prompt.close();
  process.stdout.write("\n");
  try {
    process.stdout.write(`${await hashPassword(password)}\n`);
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "Password hashing failed",
    );
    process.exitCode = 1;
  }
});
