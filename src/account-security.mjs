import {
  hashPassword,
  verifyPassword,
  tokenHash,
  randomToken,
} from "./auth.mjs";

export class SecurityError extends Error {
  /** @param {number} status @param {string} message */
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** @param {unknown} value @returns {string} */
export function browserDescription(value) {
  return typeof value === "string"
    ? value.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 256)
    : "";
}

/** @param {import('pg').PoolClient} client @param {string} userId @param {unknown} agent @param {{id?:string,createdAt?:Date}} [existing] @returns {Promise<{token:string,csrfToken:string}>} */
export async function createBrowserSession(
  client,
  userId,
  agent,
  existing = {},
) {
  const token = randomToken();
  const csrfToken = randomToken();
  await client.query(
    `INSERT INTO sessions (token_hash,user_id,csrf_token,expires_at,id,user_agent,last_seen_at,created_at)
    VALUES ($1,$2,$3,now()+interval '7 days',COALESCE($4::uuid,gen_random_uuid()),$5,now(),COALESCE($6::timestamptz,now()))`,
    [
      tokenHash(token),
      userId,
      csrfToken,
      existing.id ?? null,
      browserDescription(agent),
      existing.createdAt ?? null,
    ],
  );
  return { token, csrfToken };
}

/** @param {import('pg').PoolClient} client @param {{id:string,tenant_id:string}} user @param {'signed_in'|'signed_out'|'password_changed'|'session_revoked'|'other_sessions_revoked'|'recovery_key_created'|'recovery_access_revoked'|'recovery_link_created'|'recovery_link_revoked'|'password_recovered'} kind @param {number} count @param {string|null} [actorId] @returns {Promise<void>} */
export async function recordSecurityEvent(
  client,
  user,
  kind,
  count,
  actorId = user.id,
) {
  await client.query(
    "INSERT INTO account_security_events (tenant_id,user_id,kind,affected_sessions,actor_id) VALUES ($1,$2,$3,$4,$5)",
    [user.tenant_id, user.id, kind, count, actorId],
  );
}

export class AccountSecurity {
  /** @param {import('pg').Pool} pool */
  constructor(pool) {
    this.pool = pool;
  }

  /** @template T @param {string} userId @param {(client:import('pg').PoolClient,user:object)=>Promise<T>} operation @returns {Promise<T>} */
  async withUser(userId, operation) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const user = (
        await client.query(
          "SELECT id,tenant_id,email,password_hash,platform_admin FROM users WHERE id=$1 FOR UPDATE",
          [userId],
        )
      ).rows[0];
      if (!user) throw new SecurityError(401, "Sign in to continue");
      const result = await operation(client, user);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /** @param {import('pg').PoolClient} client @param {{id:string,token_hash:string}} session @returns {Promise<object>} */
  async activeSession(client, session) {
    const row = (
      await client.query(
        "SELECT id,created_at FROM sessions WHERE user_id=$1 AND token_hash=$2 AND expires_at>clock_timestamp()",
        [session.id, session.token_hash],
      )
    ).rows[0];
    if (!row) throw new SecurityError(401, "Sign in to continue");
    return row;
  }

  /** @param {string} userId @param {unknown} password @returns {Promise<string>} */
  async confirmedPassword(userId, password) {
    const row = (
      await this.pool.query("SELECT password_hash FROM users WHERE id=$1", [
        userId,
      ])
    ).rows[0];
    if (
      typeof password !== "string" ||
      !(await verifyPassword(password, row?.password_hash ?? null))
    )
      throw new SecurityError(400, "Current password is incorrect");
    return row.password_hash;
  }

  /** @param {{id:string,password_hash:string}} verified @param {unknown} agent @returns {Promise<{token:string,csrfToken:string}>} */
  async login(verified, agent) {
    await this.pool.query("DELETE FROM sessions WHERE expires_at<now()");
    return this.withUser(verified.id, async (client, user) => {
      // Password verification runs outside the lock; a later change must defeat this delayed login.
      if (user.password_hash !== verified.password_hash)
        throw new SecurityError(401, "Email or password is incorrect");
      const result = await createBrowserSession(client, user.id, agent);
      await recordSecurityEvent(client, user, "signed_in", 1);
      return result;
    });
  }

  /** @param {{id:string,token_hash:string}} session @param {{currentPassword:unknown,newPassword:unknown}} passwords @param {unknown} agent @returns {Promise<{token:string,csrfToken:string}>} */
  async changePassword(session, { currentPassword, newPassword }, agent) {
    if (
      typeof currentPassword !== "string" ||
      currentPassword.length > 1024 ||
      typeof newPassword !== "string" ||
      newPassword.length < 8 ||
      newPassword.length > 1024
    )
      throw new SecurityError(
        400,
        "Enter your current password and a new password of 8 to 1024 characters",
      );
    const verifiedHash = await this.confirmedPassword(
      session.id,
      currentPassword,
    );
    if (newPassword === currentPassword)
      throw new SecurityError(400, "Choose a different password");
    const replacement = await hashPassword(newPassword);
    return this.withUser(session.id, async (client, user) => {
      const current = await this.activeSession(client, session);
      if (user.password_hash !== verifiedHash)
        throw new SecurityError(
          409,
          "Account security changed. Refresh and try again.",
        );
      await client.query(
        "UPDATE users SET password_hash=$2,password_changed_at=now() WHERE id=$1",
        [user.id, replacement],
      );
      const removed = await client.query(
        "DELETE FROM sessions WHERE user_id=$1",
        [user.id],
      );
      await client.query(
        "UPDATE account_recovery_tokens SET revoked_at=now() WHERE user_id=$1 AND kind='admin_link' AND used_at IS NULL AND revoked_at IS NULL",
        [user.id],
      );
      // The public browser ID is stable; its authentication token and CSRF secret are renewed.
      const result = await createBrowserSession(client, user.id, agent, {
        id: current.id,
        createdAt: current.created_at,
      });
      await recordSecurityEvent(
        client,
        user,
        "password_changed",
        removed.rowCount,
      );
      return result;
    });
  }

  /** @param {{id:string,token_hash:string}} session @param {string|null} target @returns {Promise<number>} */
  async revoke(session, target) {
    if (
      target !== null &&
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
        target,
      )
    )
      throw new SecurityError(400, "Choose a valid browser session");
    return this.withUser(session.id, async (client, user) => {
      const current = await this.activeSession(client, session);
      if (target === current.id)
        throw new SecurityError(
          400,
          "Use Sign out to end this browser session",
        );
      const result = await client.query(
        "DELETE FROM sessions WHERE user_id=$1 AND token_hash<>$2 AND expires_at>now() AND ($3::uuid IS NULL OR id=$3::uuid)",
        [user.id, session.token_hash, target],
      );
      if (target && !result.rowCount)
        throw new SecurityError(404, "Browser session is no longer active");
      await recordSecurityEvent(
        client,
        user,
        target ? "session_revoked" : "other_sessions_revoked",
        result.rowCount,
      );
      return result.rowCount;
    });
  }

  /** @param {{id:string,session_id:string}} session @returns {Promise<void>} */
  async logout(session) {
    await this.withUser(session.id, async (client, user) => {
      // An already authenticated logout also ends access renewed while it was waiting.
      const result = await client.query(
        "DELETE FROM sessions WHERE user_id=$1 AND id=$2",
        [user.id, session.session_id],
      );
      if (result.rowCount)
        await recordSecurityEvent(client, user, "signed_out", 1);
    });
  }

  /** @param {{id:string,token_hash:string}} session @param {number} offset @returns {Promise<object>} */
  async list(session, offset) {
    const [user, browsers, count, events, recovery] = await Promise.all([
      this.pool.query("SELECT password_changed_at FROM users WHERE id=$1", [
        session.id,
      ]),
      this.pool.query(
        `SELECT id,user_agent,created_at,last_seen_at,expires_at,token_hash=$2 AS current FROM sessions
        WHERE user_id=$1 AND expires_at>now() ORDER BY (token_hash=$2) DESC,created_at DESC,id DESC LIMIT 21 OFFSET $3`,
        [session.id, session.token_hash, offset],
      ),
      this.pool.query(
        "SELECT count(*)::integer AS n FROM sessions WHERE user_id=$1 AND expires_at>now()",
        [session.id],
      ),
      this.pool.query(
        "SELECT id,kind,affected_sessions,occurred_at FROM account_security_events WHERE user_id=$1 ORDER BY occurred_at DESC,id DESC LIMIT 20",
        [session.id],
      ),
      this.pool.query(
        "SELECT kind,created_at,expires_at FROM account_recovery_tokens WHERE user_id=$1 AND used_at IS NULL AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>now())",
        [session.id],
      ),
    ]);
    return {
      passwordChangedAt: user.rows[0]?.password_changed_at ?? null,
      recovery: {
        keyCreatedAt:
          recovery.rows.find((row) => row.kind === "saved_key")?.created_at ??
          null,
        linkExpiresAt:
          recovery.rows.find((row) => row.kind === "admin_link")?.expires_at ??
          null,
      },
      sessions: browsers.rows.slice(0, 20).map((row) => ({
        id: row.id,
        current: row.current,
        userAgent: row.user_agent,
        createdAt: row.created_at,
        lastSeenAt: row.last_seen_at,
        expiresAt: row.expires_at,
      })),
      sessionCount: count.rows[0].n,
      hasMoreSessions: browsers.rows.length > 20,
      offset,
      events: events.rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        affectedSessions: row.affected_sessions,
        at: row.occurred_at,
      })),
    };
  }
}
