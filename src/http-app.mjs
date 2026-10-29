import { readFile } from "node:fs/promises";
import { outageRoute } from "./outage-http.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  LoginLimiter,
  verifyPassword,
  tokenHash,
  readCookie,
  equalToken,
} from "./auth.mjs";
import { AccountRecovery } from "./account-recovery.mjs";
import { Invitations } from "./invitations.mjs";
import { TenantLifecycle } from "./tenant-lifecycle.mjs";
import { WorkspaceData } from "./workspace-data.mjs";
import { WorkspaceOffboarding } from "./workspace-offboarding.mjs";
import { summarize, localDay, dayStart, addDays } from "./analytics.mjs";
import { historyEvidence, writeHistory } from "./command-history.mjs";
import { readBackupStatus } from "./backup-status.mjs";
import {
  AccountSecurity,
  SecurityError,
  browserDescription,
} from "./account-security.mjs";

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** @param {import('node:http').IncomingMessage} request @returns {Promise<Record<string, unknown>>} */
async function bodyJson(request) {
  if (!request.headers["content-type"]?.startsWith("application/json"))
    throw new HttpError(415, "JSON content is required");
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 8192) throw new HttpError(413, "Request is too large");
    chunks.push(chunk);
  }
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Invalid JSON");
  }
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new HttpError(400, "Invalid request");
  return body;
}

/** @param {import('node:http').ServerResponse} response @param {number} status @param {object} value @returns {void} */
function json(response, status, value) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(value));
}

/** @param {object} row @returns {object | null} */
function measurement(row) {
  return row
    ? {
        at: new Date(row.observed_at).toISOString(),
        receivedAt: new Date(row.received_at).toISOString(),
        source: row.reading_source,
        samplingSeconds: row.sampling_seconds,
        soc: Number(row.soc),
        pvW: Number(row.pv_w),
        loadW: Number(row.load_w),
        gridW: Number(row.grid_w),
        batteryW: Number(row.battery_w),
        temperatureC: Number(row.temperature_c),
        acEnabled: row.ac_enabled,
      }
    : null;
}

/** @param {{ pool: import('pg').Pool, hub: object, config: object }} options @returns {function} */
export function createApp({ pool, hub, config }) {
  const limiter = new LoginLimiter();
  const securityLimiter = new LoginLimiter();
  const security = new AccountSecurity(pool);
  const recovery = new AccountRecovery(pool);
  const invitations = new Invitations(pool);
  const lifecycle = new TenantLifecycle(pool);
  const workspaceData = new WorkspaceData(pool);
  const offboarding =
    hub.offboarding ??
    new WorkspaceOffboarding(pool, hub, {
      guardFile: config.erasureGuardFile ?? null,
      requireRoot: config.secure,
    });
  /** @param {import('node:http').IncomingMessage} request @param {import('node:http').ServerResponse} response @param {string} purpose @returns {string} */
  const limitPublic = (request, response, purpose) => {
    const trusted = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(
      request.socket.remoteAddress,
    );
    const address =
      trusted && typeof request.headers["x-real-ip"] === "string"
        ? request.headers["x-real-ip"]
        : request.socket.remoteAddress;
    const key = `${purpose}:${address ?? "unknown"}`;
    if (!limiter.allow(key)) {
      response.setHeader("retry-after", "900");
      throw new HttpError(429, "Too many attempts. Try again in 15 minutes.");
    }
    return key;
  };
  /** @param {import('node:http').ServerResponse} response @param {{id:string}} session @returns {void} */
  const limitSecurity = (response, session) => {
    if (!securityLimiter.allow(session.id)) {
      response.setHeader("retry-after", "900");
      throw new HttpError(429, "Too many attempts. Try again in 15 minutes.");
    }
  };
  const cookieName = config.secure
    ? "__Host-solarman_session"
    : "solarman_session";
  const staticRoot = path.resolve(
    fileURLToPath(new URL("../dist/web/", import.meta.url)),
  );
  const cookie = (token, maxAge = 604800) =>
    `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${config.secure ? "; Secure" : ""}`;
  const latest = async (tenantId) =>
    (
      await pool.query(
        `SELECT m.* FROM measurements m
    JOIN solarman_accounts a ON a.id=m.account_id AND a.tenant_id=m.tenant_id
    WHERE m.tenant_id=$1 AND m.device=a.device_sn ORDER BY m.observed_at DESC LIMIT 1`,
        [tenantId],
      )
    ).rows[0] ?? null;
  const getSession = async (request) => {
    const token = readCookie(request.headers.cookie, cookieName);
    if (!token) return null;
    return (
      (
        await pool.query(
          `WITH touched AS (UPDATE sessions SET last_seen_at=now(),user_agent=CASE WHEN user_agent='' THEN $2 ELSE user_agent END WHERE token_hash=$1 AND expires_at>now()
          AND (last_seen_at IS NULL OR last_seen_at<now()-interval '5 minutes'))
          SELECT s.token_hash,s.csrf_token,s.id AS session_id,u.id,u.email,u.tenant_id,u.platform_admin,t.name AS tenant_name,a.timezone FROM sessions s
      JOIN users u ON u.id=s.user_id JOIN tenants t ON t.id=u.tenant_id
      LEFT JOIN solarman_accounts a ON a.tenant_id=u.tenant_id
      LEFT JOIN workspace_offboarding o ON o.tenant_id=u.tenant_id
      WHERE s.token_hash=$1 AND s.expires_at>now() AND o.erasure_authorized_at IS NULL`,
          [tokenHash(token), browserDescription(request.headers["user-agent"])],
        )
      ).rows[0] ?? null
    );
  };
  const sessionData = (user, csrfToken) => ({
    user: {
      id: user.id,
      email: user.email,
      platformAdmin: user.platform_admin,
    },
    tenant: {
      id: user.tenant_id,
      name: user.tenant_name,
      timezone: user.timezone ?? "Europe/Sofia",
    },
    csrfToken,
  });
  const analytics = async (
    tenantId,
    runtime,
    from,
    to,
    fullResolution = false,
  ) => {
    let start;
    let end;
    try {
      start = dayStart(from, runtime.timezone);
      end = Math.min(Date.now(), dayStart(addDays(to, 1), runtime.timezone));
    } catch {
      throw new HttpError(400, "Use a valid date range");
    }
    if (start >= end || end - start > 366 * 86400_000 || to < from)
      throw new HttpError(400, "Choose a past date range of up to one year");
    const current = await latest(tenantId);
    const device = runtime.device ?? current?.device ?? "";
    const rows = await pool.query(
      `SELECT observed_at,soc,temperature_c,pv_w,load_w,grid_w,battery_w,sampling_seconds
      FROM measurements WHERE tenant_id=$1 AND account_id=$2 AND device=$3 AND observed_at BETWEEN $4 AND $5 ORDER BY observed_at`,
      [
        tenantId,
        runtime.account?.id ?? null,
        device,
        new Date(start - 3600_000),
        new Date(end + 3600_000),
      ],
    );
    return summarize(rows.rows, {
      start,
      end,
      pollMs: runtime.pollMs,
      timezone: runtime.timezone,
      fullResolution,
    });
  };
  return async (request, response) => {
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("x-frame-options", "DENY");
    response.setHeader("referrer-policy", "same-origin");
    response.setHeader(
      "content-security-policy",
      "default-src 'self'; script-src 'self'; worker-src 'self'; manifest-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    );
    if (config.secure)
      response.setHeader("strict-transport-security", "max-age=31536000");
    try {
      const url = new URL(request.url ?? "/", config.origin);
      const pathname = url.pathname;
      if (pathname.startsWith("/solarman/callback/")) {
        const callback =
          /^\/solarman\/callback\/([a-f0-9-]{36})\/[a-f0-9]{64}$/.exec(
            pathname,
          );
        if (!callback) {
          response.writeHead(404);
          response.end();
          return;
        }
        await hub.callback(request, response, callback[1]);
        return;
      }
      if (pathname === "/healthz" && request.method === "GET") {
        const probe = url.searchParams.get("probe");
        if (
          probe !== null &&
          (!/^[a-f0-9]{32}$/.test(probe) ||
            url.searchParams.getAll("probe").length !== 1)
        )
          throw new HttpError(400, "Invalid health probe");
        await pool.query("SELECT 1");
        const monitoring = hub.operations.status().state;
        const notifications = hub.notifications?.status().state ?? "starting";
        const delayed = monitoring === "delayed" || notifications === "delayed";
        json(response, hub.stopping || delayed ? 503 : 200, {
          status: hub.stopping ? "stopping" : delayed ? "degraded" : "ok",
          release: process.env.RELEASE_SHA ?? "development",
          monitoring,
          notifications,
          ...(probe === null ? {} : { probe }),
        });
        return;
      }
      if (!pathname.startsWith("/api/")) {
        if (!["GET", "HEAD"].includes(request.method))
          throw new HttpError(405, "Method not allowed");
        let relative;
        try {
          relative = decodeURIComponent(pathname);
        } catch {
          throw new HttpError(400, "Invalid path");
        }
        const file = path.resolve(staticRoot, `.${relative}`);
        if (!file.startsWith(`${staticRoot}${path.sep}`) && file !== staticRoot)
          throw new HttpError(404, "Not found");
        const extension = path.extname(file);
        const mime = {
          ".js": "text/javascript",
          ".css": "text/css",
          ".svg": "image/svg+xml",
          ".png": "image/png",
          ".ico": "image/x-icon",
          ".woff2": "font/woff2",
          ".json": "application/json",
          ".webmanifest": "application/manifest+json",
          ".html": "text/html",
        };
        let bytes;
        try {
          bytes = await readFile(
            extension ? file : path.join(staticRoot, "index.html"),
          );
        } catch {
          throw new HttpError(404, "Page not found");
        }
        response.writeHead(200, {
          "content-type": `${mime[extension] ?? "text/html"}; charset=utf-8`,
          "cache-control": pathname.startsWith("/assets/")
            ? "public, max-age=31536000, immutable"
            : "no-cache",
        });
        response.end(request.method === "HEAD" ? undefined : bytes);
        return;
      }
      if (request.method === "POST" && request.headers.origin !== config.origin)
        throw new HttpError(403, "Request origin is not allowed");
      const watchdogPermission =
        /^\/api\/notifications\/push\/watchdog\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/.exec(pathname);
      if (watchdogPermission && request.method === "GET") {
        const probe = url.searchParams.get("probe");
        if (
          !probe ||
          !/^[a-f0-9]{32}$/.test(probe) ||
          url.searchParams.getAll("probe").length !== 1
        )
          throw new HttpError(400, "Invalid health probe");
        const limitKey = limitPublic(request, response, "watchdog-permission");
        const allowed = await hub.notifications.push.watchdogPermission(
          watchdogPermission[1],
          request.headers.authorization,
        );
        if (allowed) limiter.clear(limitKey);
        json(response, allowed ? 200 : 403, { allowed, probe });
        return;
      }
      if (pathname === "/api/notifications/push/receipt" && request.method === "POST") {
        // The encrypted push carries a one-use receipt token, including when the browser session has expired.
        const limitKey = limitPublic(request, response, "push-receipt");
        const consumed = await hub.notifications.push.receipt(await bodyJson(request));
        if (consumed) limiter.clear(limitKey);
        json(response, 202, { accepted: true });
        return;
      }
      if (pathname === "/api/auth/login" && request.method === "POST") {
        const body = await bodyJson(request);
        if (
          typeof body.email !== "string" ||
          typeof body.password !== "string" ||
          body.email.length > 254 ||
          body.password.length > 1024
        ) {
          throw new HttpError(400, "Enter your email address and password");
        }
        const trustedProxy = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(
          request.socket.remoteAddress,
        );
        const forwarded =
          trustedProxy && typeof request.headers["x-real-ip"] === "string"
            ? request.headers["x-real-ip"]
            : request.socket.remoteAddress;
        const key = `ip:${forwarded ?? "unknown"}`;
        if (!limiter.allow(key)) {
          response.setHeader("retry-after", "900");
          throw new HttpError(
            429,
            "Too many attempts. Try again in 15 minutes.",
          );
        }
        const email = body.email.trim().toLowerCase();
        const user = (
          await pool.query(
            `SELECT u.id,u.email,u.password_hash,u.tenant_id,u.platform_admin,t.name AS tenant_name,a.timezone
          FROM users u JOIN tenants t ON t.id=u.tenant_id LEFT JOIN solarman_accounts a ON a.tenant_id=u.tenant_id WHERE lower(u.email)=$1`,
            [email],
          )
        ).rows[0];
        if (!(await verifyPassword(body.password, user?.password_hash ?? null)))
          throw new HttpError(401, "Email or password is incorrect");
        const { token, csrfToken } = await security.login(
          user,
          request.headers["user-agent"],
        );
        limiter.clear(key);
        response.setHeader("set-cookie", cookie(token));
        json(response, 200, sessionData(user, csrfToken));
        return;
      }
      if (pathname === "/api/invitation" && request.method === "GET") {
        json(
          response,
          200,
          await invitations.inspect(url.searchParams.get("token")),
        );
        return;
      }
      if (pathname === "/api/invitation/inspect" && request.method === "POST") {
        const limitKey = limitPublic(request, response, "invitation");
        const body = await bodyJson(request);
        const result = await invitations.inspect(body.token);
        limiter.clear(limitKey);
        json(response, 200, result);
        return;
      }
      if (pathname === "/api/auth/activate" && request.method === "POST") {
        const limitKey = limitPublic(request, response, "activation");
        const body = await bodyJson(request);
        const result = await invitations.activate(
          body.token,
          body.password,
          request.headers["user-agent"],
        );
        response.setHeader("set-cookie", cookie(result.token));
        limiter.clear(limitKey);
        json(response, 200, sessionData(result.user, result.csrfToken));
        return;
      }
      if (pathname === "/api/auth/recover" && request.method === "POST") {
        const limitKey = limitPublic(request, response, "recovery");
        const body = await bodyJson(request);
        const next = await recovery.consume(
          body.email,
          body.key,
          body.newPassword,
        );
        limiter.clear(limitKey);
        json(response, 200, {
          ok: true,
          recoveryKey: next.key,
          createdAt: next.createdAt,
        });
        return;
      }
      const session = await getSession(request);
      if (!session) throw new HttpError(401, "Sign in to continue");
      if (
        request.method === "POST" &&
        !equalToken(request.headers["x-csrf-token"], session.csrf_token)
      )
        throw new HttpError(403, "Refresh this page and try again");
      if (pathname === "/api/auth/session" && request.method === "GET") {
        json(response, 200, sessionData(session, session.csrf_token));
        return;
      }
      if (pathname === "/api/auth/logout" && request.method === "POST") {
        await security.logout(session);
        response.setHeader("set-cookie", cookie("", 0));
        json(response, 200, { ok: true });
        return;
      }
      if (pathname === "/api/security" && request.method === "GET") {
        const offset = url.searchParams.get("offset") ?? "0";
        if (!/^\d{1,6}$/.test(offset))
          throw new HttpError(400, "Choose a valid session page");
        json(response, 200, await security.list(session, Number(offset)));
        return;
      }
      if (
        [
          "/api/security/recovery/key",
          "/api/security/recovery/revoke",
        ].includes(pathname) &&
        request.method === "POST"
      ) {
        const body = await bodyJson(request);
        limitSecurity(response, session);
        const result = pathname.endsWith("/key")
          ? await recovery.createKey(session, body.currentPassword)
          : {
              revoked: await recovery.revokeAccess(
                session,
                body.currentPassword,
              ),
            };
        securityLimiter.clear(session.id);
        json(
          response,
          200,
          result.key
            ? { key: result.key, createdAt: result.createdAt }
            : result,
        );
        return;
      }
      if (pathname === "/api/security/password" && request.method === "POST") {
        const body = await bodyJson(request);
        limitSecurity(response, session);
        const { token, csrfToken } = await security.changePassword(
          session,
          {
            currentPassword: body.currentPassword,
            newPassword: body.newPassword,
          },
          request.headers["user-agent"],
        );
        securityLimiter.clear(session.id);
        response.setHeader("set-cookie", cookie(token));
        json(response, 200, sessionData(session, csrfToken));
        return;
      }
      if (
        [
          "/api/security/sessions/revoke",
          "/api/security/sessions/revoke-others",
        ].includes(pathname) &&
        request.method === "POST"
      ) {
        const body = await bodyJson(request);
        const target = pathname.endsWith("/revoke-others") ? null : body.id;
        if (target !== null && typeof target !== "string")
          throw new HttpError(400, "Choose a valid browser session");
        json(response, 200, {
          revoked: await security.revoke(session, target),
        });
        return;
      }
      if (pathname === "/api/workspace/retention" && request.method === "GET") {
        json(response, 200, await workspaceData.retention(session.tenant_id));
        return;
      }
      if (
        pathname === "/api/workspace/offboarding" &&
        request.method === "GET"
      ) {
        json(response, 200, await offboarding.status(session.tenant_id));
        return;
      }
      const closureMatch =
        /^\/api\/admin\/tenants\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\/offboarding$/i.exec(
          pathname,
        );
      if (closureMatch && ["GET", "POST"].includes(request.method)) {
        if (!session.platform_admin)
          throw new HttpError(403, "Administrator access is required");
        if (request.method === "POST") {
          const body = await bodyJson(request);
          limitSecurity(response, session);
          await hub.updateAccount(closureMatch[1], async () => {
            const result = await offboarding.request(
              session,
              closureMatch[1],
              body,
            );
            await hub.lifecycleChanged(closureMatch[1], result.appKey);
          });
          securityLimiter.clear(session.id);
        }
        json(response, 200, await offboarding.status(closureMatch[1]));
        return;
      }
      const recoveryMatch =
        /^\/api\/admin\/tenants\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\/offboarding\/recovery$/i.exec(
          pathname,
        );
      if (recoveryMatch && request.method === "POST") {
        if (!session.platform_admin)
          throw new HttpError(403, "Administrator access is required");
        const body = await bodyJson(request);
        limitSecurity(response, session);
        await offboarding.recover(session, recoveryMatch[1], body);
        securityLimiter.clear(session.id);
        json(response, 200, await offboarding.status(recoveryMatch[1]));
        return;
      }
      if (
        pathname === "/api/workspace/retention" &&
        request.method === "POST"
      ) {
        const body = await bodyJson(request);
        limitSecurity(response, session);
        const policy = await workspaceData.updateRetention(session, body);
        securityLimiter.clear(session.id);
        json(response, 200, policy);
        return;
      }
      if (pathname === "/api/workspace/archive" && request.method === "POST") {
        const body = await bodyJson(request);
        limitSecurity(response, session);
        await workspaceData.archive(session, body.currentPassword, response);
        securityLimiter.clear(session.id);
        return;
      }
      if (pathname === "/api/admin/tenants" && request.method === "GET") {
        if (!session.platform_admin)
          throw new HttpError(403, "Administrator access is required");
        const result =
          await pool.query(`SELECT t.id,t.name,t.created_at,t.lifecycle,t.lifecycle_revision::text AS revision,a.connection_status,
          EXISTS (SELECT 1 FROM users u WHERE u.tenant_id=t.id AND u.platform_admin) AS protected,
          EXISTS (SELECT 1 FROM device_control_state d WHERE d.tenant_id=t.id AND d.state IN ('uncertain','cleanup-required')) AS cleanup_pending,
          (SELECT count(*)::integer FROM users u WHERE u.tenant_id=t.id) AS members
          FROM tenants t LEFT JOIN solarman_accounts a ON a.tenant_id=t.id ORDER BY t.created_at DESC`);
        json(response, 200, { items: result.rows });
        return;
      }
      if (pathname === "/api/workspace/lifecycle" && request.method === "GET") {
        json(response, 200, await lifecycle.status(session.tenant_id));
        return;
      }
      const lifecycleMatch =
        /^\/api\/admin\/tenants\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\/lifecycle$/i.exec(
          pathname,
        );
      if (lifecycleMatch && ["GET", "POST"].includes(request.method)) {
        if (!session.platform_admin)
          throw new HttpError(403, "Administrator access is required");
        if (request.method === "POST") {
          const body = await bodyJson(request);
          limitSecurity(response, session);
          const result = await lifecycle.change(
            session,
            lifecycleMatch[1],
            body,
          );
          securityLimiter.clear(session.id);
          if (result.changed) {
            try {
              await hub.lifecycleChanged(lifecycleMatch[1], result.appKey);
            } catch {
              console.error(
                JSON.stringify({
                  event: "workspace_lifecycle_refresh_pending",
                }),
              );
            }
          }
        }
        json(response, 200, await lifecycle.status(lifecycleMatch[1]));
        return;
      }
      if (pathname === "/api/admin/invitations" && request.method === "GET") {
        if (!session.platform_admin)
          throw new HttpError(403, "Administrator access is required");
        const offset = url.searchParams.get("offset") ?? "0";
        if (!/^\d{1,6}$/.test(offset))
          throw new HttpError(400, "Choose a valid invitation page");
        json(response, 200, await invitations.list(Number(offset)));
        return;
      }
      if (pathname === "/api/admin/invitations" && request.method === "POST") {
        if (!session.platform_admin)
          throw new HttpError(403, "Administrator access is required");
        const result = await invitations.create(
          session,
          await bodyJson(request),
        );
        json(response, 201, {
          id: result.id,
          url: `${config.origin}/activate#token=${result.token}`,
          expiresAt: result.expiresAt,
          expiresInHours: 24,
        });
        return;
      }
      const invitationAction =
        /^\/api\/admin\/invitations\/([a-f0-9-]{36})\/(revoke|reissue)$/.exec(
          pathname,
        );
      if (invitationAction && request.method === "POST") {
        if (!session.platform_admin)
          throw new HttpError(403, "Administrator access is required");
        const result = await invitations.change(
          session,
          invitationAction[1],
          invitationAction[2],
        );
        json(
          response,
          200,
          result.token
            ? {
                id: result.id,
                url: `${config.origin}/activate#token=${result.token}`,
                expiresAt: result.expiresAt,
                expiresInHours: 24,
              }
            : result,
        );
        return;
      }
      if (pathname === "/api/admin/recovery" && request.method === "POST") {
        if (!session.platform_admin)
          throw new HttpError(403, "Administrator access is required");
        const body = await bodyJson(request);
        limitSecurity(response, session);
        const result = await recovery.administrative(session, {
          email: body.email,
          currentPassword: body.currentPassword,
          action: body.action,
        });
        securityLimiter.clear(session.id);
        json(
          response,
          200,
          result.key
            ? {
                url: `${config.origin}/recover#${new URLSearchParams({ email: result.email, key: result.key })}`,
                expiresAt: result.expiresAt,
              }
            : result,
        );
        return;
      }
      if (pathname === "/api/notifications/push" && ["GET", "POST"].includes(request.method)) {
        if (request.method === "POST") {
          limitSecurity(response, session);
          await hub.notifications.push.change(session, await bodyJson(request));
          securityLimiter.clear(session.id);
        }
        json(response, 200, await hub.notifications.push.settings(session));
        return;
      }
      if (
        pathname === "/api/notifications" &&
        ["GET", "POST"].includes(request.method)
      ) {
        if (request.method === "POST") {
          limitSecurity(response, session);
          await hub.notifications.change(session, await bodyJson(request));
          securityLimiter.clear(session.id);
        }
        json(
          response,
          200,
          await hub.notifications.settings(
            session.tenant_id,
            Number(url.searchParams.get("offset") ?? 0),
          ),
        );
        return;
      }
      const runtime = await hub.forTenant(session.tenant_id);
      if (
        await outageRoute({
          pathname,
          request,
          response,
          session,
          runtime,
          bodyJson,
          json,
          limitSecurity,
          HttpError,
        })
      )
        return;
      if (
        pathname === "/api/commissioning" &&
        ["GET", "POST"].includes(request.method)
      ) {
        if (request.method === "POST") {
          limitSecurity(response, session);
          await hub.commissioning.change(
            session,
            runtime,
            await bodyJson(request),
          );
          securityLimiter.clear(session.id);
        }
        json(
          response,
          200,
          await hub.commissioning.status(session.tenant_id, runtime),
        );
        return;
      }
      if (
        pathname === "/api/policy-observations" &&
        ["GET", "POST"].includes(request.method)
      ) {
        if (request.method === "POST")
          await hub.policyObservations.change(
            session,
            runtime,
            await bodyJson(request),
          );
        json(
          response,
          200,
          await hub.policyObservations.status(
            session.tenant_id,
            runtime,
            url.searchParams.get("run"),
          ),
        );
        return;
      }
      if (pathname === "/api/overview" && request.method === "GET") {
        const today = localDay(Date.now(), runtime.timezone);
        const [current, stats, recent, alerts] = await Promise.all([
          latest(session.tenant_id),
          analytics(session.tenant_id, runtime, today, today),
          pool.query(
            "SELECT id,actor,action,status,message,created_at,completed_at FROM command_executions WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 5",
            [session.tenant_id],
          ),
          hub.operations.summary(session.tenant_id),
        ]);
        json(response, 200, {
          latest: measurement(current),
          controller: runtime.status(),
          today: stats,
          recent: recent.rows,
          alerts,
          ...(session.platform_admin
            ? { backup: await readBackupStatus(config.backupStatusFile) }
            : {}),
        });
        return;
      }
      if (pathname === "/api/analytics" && request.method === "GET") {
        const today = localDay(Date.now(), runtime.timezone);
        const result = await analytics(
          session.tenant_id,
          runtime,
          url.searchParams.get("from") ?? today,
          url.searchParams.get("to") ?? today,
        );
        json(response, 200, result);
        return;
      }
      if (pathname === "/api/export.csv" && request.method === "GET") {
        const today = localDay(Date.now(), runtime.timezone);
        const result = await analytics(
          session.tenant_id,
          runtime,
          url.searchParams.get("from") ?? today,
          url.searchParams.get("to") ?? today,
          true,
        );
        const header =
          "timestamp_utc,solar_w,house_w,grid_import_positive_w,battery_discharge_positive_w,soc_percent,temperature_c";
        const lines = result.points.map((p) =>
          [
            new Date(p.at).toISOString(),
            p.pvW,
            p.loadW,
            p.gridW,
            p.batteryW,
            p.soc,
            p.temperatureC,
          ].join(","),
        );
        response.writeHead(200, {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition":
            'attachment; filename="solarman-measurements.csv"',
          "cache-control": "no-store",
        });
        response.end([header, ...lines].join("\n"));
        return;
      }
      if (pathname === "/api/operations" && request.method === "GET") {
        const filter = url.searchParams.get("filter") ?? "active";
        const offsetText = url.searchParams.get("offset") ?? "0";
        if (
          !["active", "resolved", "all"].includes(filter) ||
          !/^\d{1,6}$/.test(offsetText)
        )
          throw new HttpError(400, "Invalid incident filter or page");
        const [history, deviceHealth] = await Promise.all([
          hub.operations.list(session.tenant_id, filter, Number(offsetText)),
          hub.operations.deviceStatus(session.tenant_id),
        ]);
        json(response, 200, {
          ...history,
          deviceHealth,
          ...(session.platform_admin
            ? {
                backup: await readBackupStatus(config.backupStatusFile),
                erasure: await offboarding.serviceStatus(),
              }
            : {}),
        });
        return;
      }
      const incidentMatch =
        /^\/api\/incidents\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\/acknowledge$/i.exec(
          pathname,
        );
      if (incidentMatch && request.method === "POST") {
        const body = await bodyJson(request);
        if (
          !Number.isInteger(body.revision) ||
          body.revision < 1 ||
          body.revision > 2147483647
        )
          throw new HttpError(400, "A current alert revision is required");
        const incident = await hub.operations.acknowledge(
          session.tenant_id,
          incidentMatch[1],
          session.id,
          body.revision,
        );
        if (!incident) {
          const owned = await pool.query(
            "SELECT 1 FROM operational_incidents WHERE tenant_id=$1 AND id=$2",
            [session.tenant_id, incidentMatch[1]],
          );
          throw new HttpError(
            owned.rowCount ? 409 : 404,
            owned.rowCount
              ? "This alert changed. Refresh status before marking it as seen."
              : "Alert not found",
          );
        }
        json(response, 200, incident);
        return;
      }
      if (pathname === "/api/activity" && request.method === "GET") {
        const offsetText = url.searchParams.get("offset") ?? "0";
        if (!/^\d{1,6}$/.test(offsetText))
          throw new HttpError(400, "Invalid page");
        const offset = Number(offsetText);
        const search = (url.searchParams.get("search") ?? "").slice(0, 100);
        const result = await pool.query(
          `SELECT id,actor,action,status,message,created_at,completed_at FROM command_executions
          WHERE tenant_id=$1 AND ($2='' OR action ILIKE $3 OR actor ILIKE $3 OR message ILIKE $3)
          ORDER BY created_at DESC LIMIT 26 OFFSET $4`,
          [session.tenant_id, search, `%${search}%`, offset],
        );
        json(response, 200, {
          items: result.rows.slice(0, 25),
          hasMore: result.rows.length > 25,
          offset,
        });
        return;
      }
      if (pathname === "/api/write-history" && request.method === "GET") {
        const offsetText = url.searchParams.get("offset") ?? "0";
        if (!/^\d{1,6}$/.test(offsetText))
          throw new HttpError(400, "Invalid page");
        json(
          response,
          200,
          await writeHistory(pool, session.tenant_id, {
            offset: Number(offsetText),
          }),
        );
        return;
      }
      const activityMatch =
        /^\/api\/activity\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i.exec(
          pathname,
        );
      if (activityMatch && request.method === "GET") {
        const offsetText = url.searchParams.get("offset") ?? "0";
        if (!/^\d{1,6}$/.test(offsetText))
          throw new HttpError(400, "Invalid page");
        const offset = Number(offsetText);
        const result = await pool.query(
          "SELECT id,actor,action,status,message,device,detail,created_at,completed_at FROM command_executions WHERE tenant_id=$1 AND id=$2",
          [session.tenant_id, activityMatch[1]],
        );
        if (!result.rowCount) throw new HttpError(404, "Command not found");
        const { detail, ...job } = result.rows[0];
        json(response, 200, {
          ...job,
          evidence: historyEvidence(detail),
          ...(await writeHistory(pool, session.tenant_id, {
            executionId: job.id,
            offset,
          })),
        });
        return;
      }
      if (pathname === "/api/settings" && request.method === "GET") {
        const usage = await pool.query(
          `SELECT count(*) FILTER (WHERE created_at>=now()-interval '24 hours')::integer AS today,
          count(*) FILTER (WHERE created_at>=date_trunc('year',now()))::integer AS year FROM api_requests WHERE tenant_id=$1`,
          [session.tenant_id],
        );
        json(response, 200, {
          controller: runtime.status(),
          timezone: runtime.timezone,
          apiUsage: usage.rows[0],
          quota: hub.budget.policy.limit,
          budget: await hub.budgetInfo(runtime),
          profile: runtime.account?.profile ?? "monitor-only",
          ...(await hub.accountInfo(session.tenant_id)),
          release: process.env.RELEASE_SHA ?? "development",
        });
        return;
      }
      if (
        [
          "/api/account/link",
          "/api/account/discover",
          "/api/account/device",
        ].includes(pathname) &&
        request.method === "POST"
      ) {
        const body = await bodyJson(request);
        try {
          await hub.updateAccount(session.tenant_id, async () => {
            if (pathname.endsWith("/link"))
              await hub.connect(session.tenant_id, body);
            if (pathname.endsWith("/discover")) {
              await hub.discover(session.tenant_id);
              await hub.reload(session.tenant_id);
            }
            if (pathname.endsWith("/device"))
              await hub.bind(session.tenant_id, body);
          });
        } catch (error) {
          throw new HttpError(
            409,
            error instanceof Error ? error.message : "Account update failed",
          );
        }
        json(response, 200, await hub.accountInfo(session.tenant_id));
        return;
      }
      if (pathname === "/api/commands" && request.method === "POST") {
        const body = await bodyJson(request);
        const key = request.headers["idempotency-key"];
        if (
          typeof body.action !== "string" ||
          ![
            "refresh",
            "verify",
            "enable_controls",
            "commission_controls",
            "commission_topup",
            "commission_recovery",
            "disable_controls",
            "retry_capacity",
            "topup",
            "stop",
            "pause",
            "resume",
          ].includes(body.action)
        )
          throw new HttpError(400, "Unknown command");
        if (
          typeof key !== "string" ||
          !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
            key,
          )
        )
          throw new HttpError(400, "A unique request identifier is required");
        try {
          json(response, 202, await runtime.submit(body.action, session, key));
        } catch (error) {
          throw new HttpError(
            409,
            error instanceof Error
              ? error.message
              : "Command could not be queued",
          );
        }
        return;
      }
      const match =
        /^\/api\/commands\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/.exec(
          pathname,
        );
      if (match && request.method === "GET") {
        const result = await pool.query(
          "SELECT id,actor,action,status,message,created_at,completed_at FROM command_executions WHERE tenant_id=$1 AND id=$2",
          [session.tenant_id, match[1]],
        );
        if (!result.rowCount) throw new HttpError(404, "Command not found");
        json(response, 200, result.rows[0]);
        return;
      }
      throw new HttpError(404, "Endpoint not found");
    } catch (error) {
      if (response.destroyed) return;
      if (response.headersSent) {
        response.end();
        return;
      }
      const expected =
        error instanceof HttpError || error instanceof SecurityError;
      const status = expected ? error.status : 500;
      if (status === 500)
        console.error(
          JSON.stringify({
            event: "http_request_failed",
            code: typeof error?.code === "string" ? error.code : "internal",
          }),
        );
      json(response, status, {
        error: expected
          ? error.message
          : "The request could not be completed. Please try again.",
      });
    }
  };
}
