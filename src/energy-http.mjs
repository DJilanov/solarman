import { requireActiveTenant } from "./tenant-lifecycle.mjs";
import { SecurityError } from "./account-security.mjs";

/** @param {object} options @returns {Promise<boolean>} */
export async function energyRoute({
  pathname,
  request,
  response,
  session,
  runtime,
  hub,
  bodyJson,
  json,
  HttpError,
  limitSecurity,
}) {
  if (pathname !== "/api/energy" && !pathname.startsWith("/api/energy/"))
    return false;
  try {
    if (pathname === "/api/energy" && request.method === "GET") {
      json(response, 200, await hub.energy.status(runtime));
      return true;
    }
    if (
      request.method !== "POST" ||
      ![
        "/api/energy/settings",
        "/api/energy/refresh",
        "/api/energy/apply",
        "/api/energy/pause",
        "/api/energy/adjust",
        "/api/energy/hints",
      ].includes(pathname)
    )
      return false;
    await requireActiveTenant(hub.pool, session.tenant_id);
    const body = await bodyJson(request),
      action = pathname.split("/").at(-1);
    if (action === "apply" || action === "adjust")
      limitSecurity(response, session);
    const result =
      action === "hints"
        ? await hub.energy.installationHints(runtime)
        : action === "adjust"
          ? await hub.energy.adjust(runtime, body)
          : action === "refresh"
            ? await hub.energy.refresh(runtime, body.revision)
            : await hub.energy.change(
                session,
                action,
                body,
                request.headers["idempotency-key"],
                runtime,
              );
    json(response, 202, result);
  } catch (error) {
    if (error instanceof SecurityError || error instanceof HttpError)
      json(response, error.status, { error: error.message });
    else
      json(response, 503, {
        error:
          "Energy planning could not be confirmed; refresh its current state before retrying",
      });
  }
  return true;
}
