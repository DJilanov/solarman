import { OutageError } from "./outage-control.mjs";
import { SecurityError } from "./account-security.mjs";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

/** @param {object} options @returns {Promise<boolean>} */
export async function outageRoute({
  pathname,
  request,
  response,
  session,
  runtime,
  bodyJson,
  json,
  limitSecurity,
  HttpError,
}) {
  if (!pathname.startsWith("/api/outage")) return false;
  try {
    if (pathname === "/api/outage" && request.method === "GET") {
      await runtime.outage.load();
      json(response, 200, runtime.outage.status());
      return true;
    }
    if (
      request.method !== "POST" ||
      ![
        "/api/outage/prepare",
        "/api/outage/restore",
        "/api/outage/approve",
      ].includes(pathname)
    )
      return false;
    const body = await bodyJson(request);
    if (pathname.endsWith("/approve")) {
      limitSecurity(response, session);
      if (
        typeof body.revision !== "string" ||
        !/^\d{1,18}$/.test(body.revision)
      )
        throw new OutageError(400, "Choose the current outage test revision");
      json(response, 200, await runtime.outage.approve(session, body));
      return true;
    }
    const key = request.headers["idempotency-key"];
    if (typeof key !== "string" || !UUID.test(key))
      throw new OutageError(400, "A unique request identifier is required");
    if (pathname.endsWith("/prepare"))
      json(response, 202, await runtime.outage.prepare(session, body, key));
    else {
      if (
        typeof body.revision !== "string" ||
        !/^\d{1,18}$/.test(body.revision)
      )
        throw new OutageError(
          400,
          "Choose the current outage preparation revision",
        );
      json(
        response,
        202,
        await runtime.outage.restore(session, key, body.revision),
      );
    }
    return true;
  } catch (error) {
    if (
      error instanceof OutageError ||
      error instanceof SecurityError ||
      (HttpError && error instanceof HttpError)
    )
      json(response, error.status, { error: error.message });
    else
      json(response, 503, {
        error:
          "Outage preparation could not be saved; refresh its current state before retrying",
      });
    return true;
  }
}
