/** @param {NodeJS.ProcessEnv | Record<string, string | undefined>} env */
export function loadConfig(env, { deviceRequired = true } = {}) {
  const required = (name) => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`Missing environment variable: ${name}`);
    return value;
  };
  const integer = (name, fallback, min, max) => {
    const text = env[name] ?? String(fallback);
    if (!/^\d+$/.test(text)) throw new Error(`Invalid integer: ${name}`);
    const value = Number(text);
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      throw new Error(`${name} must be between ${min} and ${max}`);
    }
    return value;
  };
  const providedHash = env.SOLARMAN_PASSWORD_SHA256?.trim();
  const password = env.SOLARMAN_PASSWORD;
  if (providedHash && password)
    throw new Error(
      "Set only one of SOLARMAN_PASSWORD or SOLARMAN_PASSWORD_SHA256",
    );
  if (!providedHash && !password)
    throw new Error("Set SOLARMAN_PASSWORD or SOLARMAN_PASSWORD_SHA256");
  const passwordSha256 =
    providedHash || createHash("sha256").update(password, "utf8").digest("hex");
  if (!/^[a-f0-9]{64}$/.test(passwordSha256)) {
    throw new Error(
      "SOLARMAN_PASSWORD_SHA256 must contain 64 lowercase hex characters",
    );
  }
  const baseUrl = new URL(
    env.SOLARMAN_BASE_URL ?? "https://globalapi.solarmanpv.com",
  );
  if (
    baseUrl.protocol !== "https:" ||
    !["globalapi.solarmanpv.com", "api.solarmanpv.com"].includes(
      baseUrl.hostname,
    ) ||
    baseUrl.username ||
    baseUrl.password ||
    baseUrl.port ||
    baseUrl.pathname !== "/" ||
    baseUrl.search ||
    baseUrl.hash
  ) {
    throw new Error(
      "SOLARMAN_BASE_URL must be an official SOLARMAN HTTPS origin",
    );
  }
  const callbackUrl = new URL(required("CALLBACK_PUBLIC_URL"));
  if (
    callbackUrl.protocol !== "https:" ||
    callbackUrl.username ||
    callbackUrl.password ||
    callbackUrl.pathname !== "/" ||
    callbackUrl.search ||
    callbackUrl.hash
  ) {
    throw new Error("CALLBACK_PUBLIC_URL must be a public HTTPS origin");
  }
  const writes = env.WRITES_ENABLED ?? "false";
  if (!["true", "false"].includes(writes))
    throw new Error("WRITES_ENABLED must be true or false");
  const timezone = env.INVERTER_TIMEZONE ?? "Europe/Sofia";
  new Intl.DateTimeFormat("en-GB", { timeZone: timezone }).format();
  const pollSeconds = integer("POLL_SECONDS", 900, 30, 1800);
  const chargeWindowMinutes = integer("CHARGE_WINDOW_MINUTES", 25, 5, 45);
  if (chargeWindowMinutes * 60 <= pollSeconds + 180) {
    throw new Error(
      "CHARGE_WINDOW_MINUTES must exceed POLL_SECONDS by more than 180 seconds",
    );
  }
  return {
    appId: required("SOLARMAN_APP_ID"),
    appSecret: required("SOLARMAN_APP_SECRET"),
    email: required("SOLARMAN_EMAIL"),
    passwordSha256,
    deviceSN: deviceRequired
      ? required("SOLARMAN_DEVICE_SN")
      : (env.SOLARMAN_DEVICE_SN?.trim() ?? ""),
    baseUrl: baseUrl.origin,
    callbackOrigin: callbackUrl.origin,
    host: env.LISTEN_HOST ?? "0.0.0.0",
    port: integer("PORT", 3000, 1, 65535),
    writesEnabled: writes === "true",
    pollMs: pollSeconds * 1000,
    telemetryPollMs: integer("TELEMETRY_POLL_SECONDS", 300, 300, 1800) * 1000,
    controlAuditMs: integer("CONTROL_AUDIT_SECONDS", 3600, 900, 21600) * 1000,
    commandTimeoutMs: integer("COMMAND_TIMEOUT_SECONDS", 30, 10, 60) * 1000,
    timezone,
    chargeWindowMinutes,
  };
}
import { createHash } from "node:crypto";
