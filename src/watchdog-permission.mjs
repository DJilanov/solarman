import { createHmac, randomBytes } from "node:crypto";

export const WATCHDOG_PERMISSION_MS = 86400000;

/** @param {Buffer} key @param {{id:string,tenant_id:string,user_id:string,revision:string|number,endpoint_hash:string}} channel @returns {string} */
export function watchdogPermissionToken(key, channel) {
  return createHmac("sha256", key)
    .update(
      JSON.stringify([
        "solarman-watchdog:v1",
        channel.id,
        channel.tenant_id,
        channel.user_id,
        String(channel.revision),
        channel.endpoint_hash,
      ]),
    )
    .digest("hex");
}

/** @param {{url:string,token:string}} permission @param {{transport?:typeof fetch,signal?:AbortSignal}} [options] @returns {Promise<'allowed'|'denied'|'unavailable'>} */
export async function probeWatchdogPermission(
  permission,
  { transport = fetch, signal } = {},
) {
  const probe = randomBytes(16).toString("hex"),
    url = new URL(permission.url);
  url.searchParams.set("probe", probe);
  const deadline = AbortSignal.timeout(6000);
  let reader;
  try {
    const response = await transport(url, {
      redirect: "error",
      signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
      headers: {
        authorization: "Bearer " + permission.token,
        accept: "application/json",
        "cache-control": "no-store",
      },
    });
    reader = response.body?.getReader();
    if (!reader || ![200, 401, 403].includes(response.status))
      return "unavailable";
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 4096) return "unavailable";
      chunks.push(value);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (body?.probe !== probe || typeof body.allowed !== "boolean")
      return "unavailable";
    if (response.status !== 200 || !body.allowed) return "denied";
    return "allowed";
  } catch {
    return "unavailable";
  } finally {
    await reader?.cancel().catch(() => {});
  }
}
