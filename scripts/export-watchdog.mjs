import { constants } from "node:fs";
import { open, rm } from "node:fs/promises";
import path from "node:path";
import { dashboardConfig } from "../src/dashboard-config.mjs";
import { createPool } from "../src/database.mjs";
import { encryptionKey } from "../src/credentials.mjs";
import {
  decryptPushSubscription,
  webPushConfiguration,
} from "../src/web-push.mjs";
import { watchdogPermissionToken } from "../src/watchdog-permission.mjs";
import { watchdogConfig } from "../src/watchdog-config.mjs";

async function main() {
  const [id, file] = process.argv.slice(2);
  if (
    process.argv.length !== 4 ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
      id ?? "",
    ) ||
    !file ||
    !path.isAbsolute(file)
  )
    throw new Error();
  const pool = createPool(dashboardConfig(process.env).database);
  let handle;
  let created = false;
  try {
    const channel = (
      await pool.query(
        `SELECT c.* FROM notification_channels c JOIN users u ON u.tenant_id=c.tenant_id AND u.id=c.user_id
       JOIN tenants t ON t.id=c.tenant_id WHERE c.id=$1 AND c.kind='webpush' AND u.platform_admin
       AND c.enabled AND c.verified_at IS NOT NULL AND NOT c.quarantined AND c.revoked_at IS NULL AND t.lifecycle='active'`,
        [id],
      )
    ).rows[0];
    const vapid = webPushConfiguration(process.env);
    if (!channel || !vapid) throw new Error();
    const key = encryptionKey(process.env.CREDENTIAL_ENCRYPTION_KEY);
    const origin = new URL(process.env.PUBLIC_URL).origin;
    const config = watchdogConfig({
      version: 1,
      url: origin + "/healthz",
      originHost: process.env.WATCHDOG_ORIGIN_HOST ?? "92.247.242.86",
      originPort: 443,
      label: "Solarman",
      language: channel.language,
      delivery: {
        kind: "webpush",
        subscription: decryptPushSubscription(
          channel.secret,
          key,
          channel.tenant_id,
          channel.id,
        ),
        vapid,
        permission: {
          url: origin + "/api/notifications/push/watchdog/" + channel.id,
          token: watchdogPermissionToken(key, channel),
        },
        enabled: false,
      },
    });
    handle = await open(
      file,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    created = true;
    await handle.writeFile(JSON.stringify(config) + "\n");
    await handle.sync();
    console.log(
      JSON.stringify({ exported: true, transport: "webpush", enabled: false }),
    );
  } catch {
    await handle?.close();
    handle = null;
    if (created) await rm(file, { force: true });
    throw new Error();
  } finally {
    await handle?.close();
    await pool.end();
  }
}

main().catch(() => {
  console.error(
    "Watchdog export failed; select a verified administrator device and an unused private path.",
  );
  process.exitCode = 1;
});
