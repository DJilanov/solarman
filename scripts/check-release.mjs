import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { verifyRelease } from "./release.mjs";

try {
  const sha = process.env.RELEASE_SHA;
  if (!sha || !/^[a-f0-9]{40}$/.test(sha))
    throw new Error("An expected release SHA is required");
  const directory = path.resolve(
    fileURLToPath(new URL("../", import.meta.url)),
  );
  const processes = JSON.parse(
    execFileSync("pm2", ["jlist"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 8 * 1024 * 1024,
    }),
  );
  const app = processes.find((process) => process.name === "solarman");
  if (!app) throw new Error("The SOLARMAN process is missing");
  const [healthResponse, pageResponse, index] = await Promise.all([
    fetch("http://127.0.0.1:3230/healthz", {
      signal: AbortSignal.timeout(5000),
    }),
    fetch("http://127.0.0.1:3230/", { signal: AbortSignal.timeout(5000) }),
    readFile(path.join(directory, "dist/web/index.html"), "utf8"),
  ]);
  if (!healthResponse.ok || !pageResponse.ok)
    throw new Error("The release is not responding successfully");
  verifyRelease(
    { directory, sha, index },
    {
      cwd: app.pm2_env.pm_cwd,
      script: app.pm2_env.pm_exec_path,
      status: app.pm2_env.status,
      health: await healthResponse.json(),
      index: await pageResponse.text(),
    },
  );
} catch {
  console.error(
    "Release verification failed: check the PM2 working directory, health and built page",
  );
  process.exitCode = 1;
}
