import { sealedConfig } from "../src/backup-io.mjs";
import { syncErasures } from "../src/erasure-sync.mjs";

try {
  const config = await sealedConfig("/etc/solarman-backup/config.json");
  const result = await syncErasures(config);
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(
    JSON.stringify({
      state: "failed",
      code: /^erasure_[a-z_]+$/.test(error?.code ?? "")
        ? error.code
        : "erasure_sync_failed",
    }),
  );
  process.exitCode = 1;
}
