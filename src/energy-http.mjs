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
    if (pathname === "/api/energy/tools/away/preview" && request.method === "POST") {
      await requireActiveTenant(hub.pool, session.tenant_id);
      json(response, 200, await hub.energy.experience.away.preview(runtime, await bodyJson(request)));
      return true;
    }
    if (pathname === "/api/energy/tools" && request.method === "GET") {
      json(response, 200, await hub.energy.experience.status(runtime));
      return true;
    }
    if (pathname.startsWith("/api/energy/tools/outage-notices/") && request.method === "GET") {
      json(response, 200, await hub.energy.experience.outageWatch.notice(runtime, pathname.split("/").at(-1)));
      return true;
    }
    if (request.method === "POST" && ["/api/energy/tools/replan", "/api/energy/tools/insight", "/api/energy/tools/outage-watch", "/api/energy/tools/outage-watch/check", "/api/energy/tools/outage-watch/areas"].includes(pathname)) {
      await requireActiveTenant(hub.pool, session.tenant_id);
      const body = await bodyJson(request), experience = hub.energy.experience;
      let result;
      if (pathname.endsWith("/replan")) result = await experience.replan(session, runtime, body);
      else if (pathname.endsWith("/insight")) result = await experience.insights.acknowledge(session, runtime, body);
      else if (pathname.endsWith("/check")) result = await experience.outageWatch.check(runtime, true);
      else if (pathname.endsWith("/areas")) {
        limitSecurity(response, session);
        const notices = await experience.outageWatch.provider.publications();
        result = [...new Map(notices.map(notice => [`${notice.municipality}:${notice.area}`, { municipality: notice.municipality, area: notice.area }])).values()];
      } else {
        limitSecurity(response, session);
        result = await experience.outageWatch.change(session, runtime, body);
      }
      json(response, 200, result);
      return true;
    }
    if (request.method === "POST" && ["/api/energy/tools/preferences", "/api/energy/tools/outage", "/api/energy/tools/task", "/api/energy/tools/away"].includes(pathname)) {
      await requireActiveTenant(hub.pool, session.tenant_id);
      const body = await bodyJson(request), action = pathname.split("/").at(-1);
      if (["preferences", "away"].includes(action)) limitSecurity(response, session);
      const result = action === "preferences"
        ? await hub.energy.experience.changePreferences(session, runtime, body)
        : action === "away" ? await hub.energy.experience.away.change(session, runtime, body, request.headers["idempotency-key"])
          : action === "outage" ? await hub.energy.experience.outage(runtime, body)
          : await hub.energy.experience.task(session, runtime, body);
      json(response, 200, result);
      return true;
    }
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
