import { randomBytes } from "node:crypto";
import { createConnection } from "node:net";

/** @typedef {{healthy:boolean,code:'healthy'|'http_error'|'invalid_health'|'stale_response'|'endpoint_unreachable'|'probe_timeout',release:string|null}} HealthSample */

/** @param {string} address @param {{transport?:typeof fetch,timeoutMs?:number,signal?:AbortSignal}} [options] @returns {Promise<HealthSample>} */
export async function probeHealth(
  address,
  { transport = fetch, timeoutMs = 8000, signal } = {},
) {
  const probe = randomBytes(16).toString("hex"),
    url = new URL(address);
  url.searchParams.set("probe", probe);
  const deadline = AbortSignal.timeout(timeoutMs);
  const abort = signal ? AbortSignal.any([signal, deadline]) : deadline;
  let reader;
  try {
    const response = await transport(url, {
      redirect: "error",
      signal: abort,
      headers: {
        accept: "application/json",
        "cache-control": "no-cache, no-store",
      },
    });
    reader = response.body?.getReader();
    if (response.status !== 200)
      return { healthy: false, code: "http_error", release: null };
    if (!reader)
      return { healthy: false, code: "invalid_health", release: null };
    const chunks = [];
    let size = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 4096)
        return { healthy: false, code: "invalid_health", release: null };
      chunks.push(value);
    }
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      return { healthy: false, code: "invalid_health", release: null };
    }
    if (!body || typeof body !== "object" || Array.isArray(body))
      return { healthy: false, code: "invalid_health", release: null };
    if (body.probe !== probe)
      return { healthy: false, code: "stale_response", release: null };
    if (
      body.status !== "ok" ||
      body.monitoring !== "current" ||
      body.notifications !== "current" ||
      typeof body.release !== "string" ||
      !/^[a-f0-9]{40}$/.test(body.release)
    )
      return { healthy: false, code: "invalid_health", release: null };
    return { healthy: true, code: "healthy", release: body.release };
  } catch {
    return {
      healthy: false,
      code: deadline.aborted ? "probe_timeout" : "endpoint_unreachable",
      release: null,
    };
  } finally {
    await reader?.cancel().catch(() => {});
  }
}

/** @param {string} host @param {number} port @param {{timeoutMs?:number,signal?:AbortSignal}} [options] @returns {Promise<'reachable'|'unavailable'|'timeout'|'cancelled'>} */
export function probeOrigin(host, port, { timeoutMs = 5000, signal } = {}) {
  if (signal?.aborted) return Promise.resolve("cancelled");
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    let finished = false;
    const finish = (result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      socket.destroy();
      resolve(result);
    };
    const cancel = () => finish("cancelled");
    const timer = setTimeout(() => finish("timeout"), timeoutMs);
    signal?.addEventListener("abort", cancel, { once: true });
    socket.once("connect", () => finish("reachable"));
    socket.once("error", () => finish("unavailable"));
  });
}
