import { readFile } from "node:fs/promises";
import { dashboardConfig } from "../src/dashboard-config.mjs";
import { createPool } from "../src/database.mjs";
import {
  nightTrialConfig,
  expireNightTrial,
  remindNightTrial,
  registerNightTrial,
  makeNightTrialPermanent,
} from "../src/night-trial.mjs";

try {
  const [action, file] = process.argv.slice(2);
  if (
    !["check", "register", "expire", "review", "permanent"].includes(action) ||
    !file?.startsWith("/")
  )
    throw new Error("Invalid night trial job");
  const config = nightTrialConfig(JSON.parse(await readFile(file, "utf8")));
  if (action === "check")
    console.log(
      JSON.stringify({
        state: "valid",
        trialId: config.trialId,
        expiresAt: config.expiresAt,
        reviewAt: config.reviewAt,
      }),
    );
  else {
    const pool = createPool(dashboardConfig(process.env).database);
    try {
      const operation = action === "permanent"
        ? makeNightTrialPermanent
        : action === "register"
          ? registerNightTrial
          : action === "expire"
            ? expireNightTrial
            : remindNightTrial;
      const result = await operation(pool, config);
      console.log(JSON.stringify(result));
      if (action === "permanent" && result.state !== "permanent")
        process.exitCode = 1;
    } finally {
      await pool.end();
    }
  }
} catch {
  console.error("Night trial job could not complete");
  process.exitCode = 1;
}
