import { createECDH, ECDH, createHash } from "node:crypto";
import webpush from "web-push";
import { sealSecret, openSecret } from "./stored-secret.mjs";

/** @typedef {{endpoint:string,keys:{p256dh:string,auth:string}}} WebPushSubscription */
/** @typedef {{publicKey:string,privateKey:string,subject:string}} WebPushConfiguration */

/** @param {unknown} value @param {number} length @returns {Buffer} */
function keyBytes(value, length) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+={0,2}$/.test(value))
    throw new Error("Invalid push key");
  const bytes = Buffer.from(value, "base64url");
  if (
    bytes.length !== length ||
    bytes.toString("base64url") !== value.replace(/=+$/, "")
  )
    throw new Error("Invalid push key");
  return bytes;
}

/** @param {unknown} value @returns {WebPushSubscription} */
export function normalizePushSubscription(value) {
  if (
    !value ||
    typeof value !== "object" ||
    typeof value.endpoint !== "string" ||
    value.endpoint.length > 4096
  )
    throw new Error("Invalid push subscription");
  const endpoint = new URL(value.endpoint);
  const host = endpoint.hostname;
  // Restrict authenticated subscriptions to known browser push services.
  const provider =
    host === "web.push.apple.com" ||
    host.endsWith(".push.apple.com") ||
    host === "fcm.googleapis.com" ||
    host === "updates.push.services.mozilla.com";
  if (
    !provider ||
    endpoint.protocol !== "https:" ||
    endpoint.port ||
    endpoint.username ||
    endpoint.password ||
    endpoint.hash ||
    endpoint.pathname === "/"
  )
    throw new Error("Unsupported push service");
  const publicKey = keyBytes(value.keys?.p256dh, 65);
  ECDH.convertKey(publicKey, "prime256v1");
  if (publicKey[0] !== 4) throw new Error("Invalid push key");
  return {
    endpoint: endpoint.href,
    keys: {
      p256dh: publicKey.toString("base64url"),
      auth: keyBytes(value.keys?.auth, 16).toString("base64url"),
    },
  };
}

/** @param {Record<string,string|undefined>} env @returns {WebPushConfiguration|null} */
export function webPushConfiguration(env) {
  if (!env.WEB_PUSH_PUBLIC_KEY && !env.WEB_PUSH_PRIVATE_KEY) return null;
  const publicKey = keyBytes(env.WEB_PUSH_PUBLIC_KEY, 65);
  const privateKey = keyBytes(env.WEB_PUSH_PRIVATE_KEY, 32);
  const pair = createECDH("prime256v1");
  pair.setPrivateKey(privateKey);
  if (!pair.getPublicKey().equals(publicKey))
    throw new Error("Web Push keys do not match");
  const subject = new URL(env.PUBLIC_URL ?? "http://localhost");
  if (
    (subject.protocol !== "https:" && subject.hostname !== "localhost") ||
    subject.username ||
    subject.password
  )
    throw new Error("Invalid Web Push origin");
  return {
    publicKey: publicKey.toString("base64url"),
    privateKey: privateKey.toString("base64url"),
    subject: subject.origin,
  };
}

/** @param {WebPushSubscription} value @returns {string} */
export function pushEndpointHash(value) {
  return createHash("sha256").update(value.endpoint).digest("hex");
}

/** @param {WebPushSubscription} value @param {Buffer} key @param {string} tenantId @param {string} channelId @returns {object} */
export function encryptPushSubscription(value, key, tenantId, channelId) {
  return sealSecret(
    normalizePushSubscription(value),
    key,
    `solarman-webpush:${tenantId}:${channelId}:v1`,
  );
}

/** @param {unknown} value @param {Buffer} key @param {string} tenantId @param {string} channelId @returns {WebPushSubscription} */
export function decryptPushSubscription(value, key, tenantId, channelId) {
  try {
    return normalizePushSubscription(
      openSecret(value, key, `solarman-webpush:${tenantId}:${channelId}:v1`),
    );
  } catch {
    throw new Error("Notification credentials could not be decrypted");
  }
}

/** @param {{subscription:WebPushSubscription,payload:object,vapid:WebPushConfiguration,signal?:AbortSignal}} input @param {typeof fetch} [transport] @returns {Promise<import('./telegram.mjs').DeliveryResult>} */
export async function sendWebPush(input, transport = fetch) {
  if (input.signal?.aborted)
    return { state: "cancelled", code: "cancelled_before_dispatch" };
  let details;
  try {
    details = webpush.generateRequestDetails(
      normalizePushSubscription(input.subscription),
      JSON.stringify(input.payload),
      {
        vapidDetails: input.vapid,
        TTL: 300,
        urgency: "high",
        contentEncoding: "aes128gcm",
      },
    );
  } catch {
    return { state: "rejected", code: "invalid_configuration" };
  }
  const deadline = AbortSignal.timeout(10000);
  const signal = input.signal
    ? AbortSignal.any([deadline, input.signal])
    : deadline;
  try {
    const response = await transport(details.endpoint, {
      method: "POST",
      headers: details.headers,
      body: details.body,
      redirect: "error",
      signal,
    });
    await response.body?.cancel().catch(() => {});
    if (response.status === 201 || response.status === 202)
      return { state: "delivered", code: "push_accepted", messageId: null };
    if (response.status === 404 || response.status === 410)
      return { state: "rejected", code: "push_expired" };
    if (response.status === 401 || response.status === 403)
      return { state: "rejected", code: "push_authorization_rejected" };
    if (response.status === 429) {
      const raw = response.headers.get("retry-after");
      const seconds =
        raw && /^\d+$/.test(raw)
          ? Number(raw)
          : raw
            ? Math.ceil((Date.parse(raw) - Date.now()) / 1000)
            : 60;
      return Number.isSafeInteger(seconds) && seconds > 0 && seconds <= 2592000
        ? { state: "retry", code: "rate_limited", retryAfter: seconds }
        : { state: "rejected", code: "rate_limit_delay_unavailable" };
    }
    return response.status >= 500
      ? { state: "retry", code: "provider_unavailable" }
      : { state: "rejected", code: "provider_rejected" };
  } catch {
    return {
      state: "unconfirmed",
      code: deadline.aborted ? "delivery_timeout" : "transport_unconfirmed",
    };
  }
}
