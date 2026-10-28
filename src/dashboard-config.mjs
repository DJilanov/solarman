import path from "node:path";

/** @param {Record<string, string | undefined>} env @returns {object} */
export function dashboardConfig(env) {
  const required = (key) => {
    const value = env[key]?.trim();
    if (!value) throw new Error(`Missing environment variable: ${key}`);
    return value;
  };
  const publicUrl = new URL(env.PUBLIC_URL ?? "http://localhost:3000");
  if (
    !["http:", "https:"].includes(publicUrl.protocol) ||
    publicUrl.username ||
    publicUrl.password ||
    publicUrl.pathname !== "/" ||
    publicUrl.search ||
    publicUrl.hash ||
    (publicUrl.protocol !== "https:" &&
      !["localhost", "127.0.0.1"].includes(publicUrl.hostname))
  ) {
    throw new Error(
      "PUBLIC_URL must be an HTTPS origin, or HTTP on localhost for development",
    );
  }
  const port = Number(env.PORT ?? 3000);
  const dbPort = Number(env.DB_PORT ?? 5432);
  if (![port, dbPort].every((n) => Number.isInteger(n) && n > 0 && n < 65536))
    throw new Error("Invalid application or database port");
  const ssl = env.DB_SSL ?? "false";
  if (!["true", "false"].includes(ssl))
    throw new Error("DB_SSL must be true or false");
  const backupStatusFile =
    env.BACKUP_STATUS_FILE?.trim() ||
    "/var/lib/solarman-backup/public/status.json";
  if (!path.isAbsolute(backupStatusFile))
    throw new Error("BACKUP_STATUS_FILE must be an absolute path");
  const erasureGuardFile =
    env.ERASURE_GUARD_FILE?.trim() ||
    (publicUrl.protocol === "https:"
      ? "/var/lib/solarman-backup/public/erasure-guard.json"
      : null);
  if (erasureGuardFile && !path.isAbsolute(erasureGuardFile))
    throw new Error("ERASURE_GUARD_FILE must be an absolute path");
  return {
    origin: publicUrl.origin,
    secure: publicUrl.protocol === "https:",
    port,
    host: env.LISTEN_HOST ?? "127.0.0.1",
    adminEmail: required("DASHBOARD_ADMIN_EMAIL").toLowerCase(),
    adminPasswordHash: required("DASHBOARD_ADMIN_PASSWORD_HASH"),
    backupStatusFile,
    erasureGuardFile,
    encryptionSecret: required("CREDENTIAL_ENCRYPTION_KEY"),
    database: {
      host: env.DB_HOST ?? "127.0.0.1",
      port: dbPort,
      database: env.DB_NAME?.trim() || env.DB_DATABASE?.trim() || "solarman",
      user: required("DB_USERNAME"),
      password: required("DB_PASSWORD"),
      max: 5,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 30_000,
      ...(ssl === "true" ? { ssl: { rejectUnauthorized: true } } : {}),
    },
  };
}
