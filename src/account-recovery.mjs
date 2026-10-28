import { hashPassword, randomToken, tokenHash } from "./auth.mjs";
import {
  AccountSecurity,
  SecurityError,
  recordSecurityEvent,
} from "./account-security.mjs";

const INVALID = "Recovery details are invalid or no longer available";

/** @param {unknown} value @returns {string} */
function emailAddress(value) {
  if (
    typeof value !== "string" ||
    value.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())
  )
    throw new SecurityError(400, "Enter a valid account email address");
  return value.trim().toLowerCase();
}

/** @param {unknown} value @returns {string} */
function recoverySecret(value) {
  const text =
    typeof value === "string" ? value.replace(/[\s-]/g, "").toLowerCase() : "";
  if (!/^[a-f0-9]{64}$/.test(text)) throw new SecurityError(400, INVALID);
  return text;
}

export class AccountRecovery {
  /** @param {import('pg').Pool} pool */
  constructor(pool) {
    this.pool = pool;
    this.security = new AccountSecurity(pool);
  }

  /** @template T @param {{id:string,token_hash:string}} session @param {unknown} password @param {(client:import('pg').PoolClient,user:object)=>Promise<T>} operation @returns {Promise<T>} */
  async withVerified(session, password, operation) {
    const verified = await this.security.confirmedPassword(
      session.id,
      password,
    );
    return this.security.withUser(session.id, async (client, user) => {
      await this.security.activeSession(client, session);
      if (user.password_hash !== verified)
        throw new SecurityError(
          409,
          "Account security changed. Refresh and try again.",
        );
      return operation(client, user);
    });
  }

  /** @param {import('pg').PoolClient} client @param {string} userId @param {'saved_key'|'admin_link'} kind @param {string} actor @returns {Promise<object>} */
  async issue(client, userId, kind, actor) {
    await client.query(
      "UPDATE account_recovery_tokens SET revoked_at=clock_timestamp() WHERE user_id=$1 AND used_at IS NULL AND revoked_at IS NULL AND ($2='saved_key' OR kind=$2)",
      [userId, kind],
    );
    const key = randomToken();
    const row = (
      await client.query(
        `INSERT INTO account_recovery_tokens (user_id,token_hash,kind,created_by,created_at,expires_at)
      VALUES ($1,$2,$3,$4,clock_timestamp(),CASE WHEN $3='admin_link' THEN clock_timestamp()+interval '30 minutes' ELSE null END) RETURNING id,created_at,expires_at`,
        [userId, tokenHash(key), kind, actor],
      )
    ).rows[0];
    return {
      key,
      id: row.id,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    };
  }

  /** @param {{id:string,token_hash:string}} session @param {unknown} password @returns {Promise<object>} */
  async createKey(session, password) {
    return this.withVerified(session, password, async (client, user) => {
      const result = await this.issue(client, user.id, "saved_key", user.id);
      await recordSecurityEvent(client, user, "recovery_key_created", 0);
      return result;
    });
  }

  /** @param {{id:string,token_hash:string}} session @param {unknown} password @returns {Promise<number>} */
  async revokeAccess(session, password) {
    return this.withVerified(session, password, async (client, user) => {
      const result = await client.query(
        "UPDATE account_recovery_tokens SET revoked_at=clock_timestamp() WHERE user_id=$1 AND used_at IS NULL AND revoked_at IS NULL",
        [user.id],
      );
      await recordSecurityEvent(client, user, "recovery_access_revoked", 0);
      return result.rowCount;
    });
  }

  /** @param {{id:string,token_hash:string}} session @param {{email:unknown,currentPassword:unknown,action:unknown}} request @returns {Promise<object>} */
  async administrative(session, request) {
    const email = emailAddress(request.email);
    if (!["issue", "revoke"].includes(request.action))
      throw new SecurityError(400, "Choose a recovery link action");
    return this.withVerified(
      session,
      request.currentPassword,
      async (client, actor) => {
        if (!actor.platform_admin)
          throw new SecurityError(403, "Administrator access is required");
        // Administrative recovery targets ordinary users; these disjoint role locks cannot cycle.
        const target = (
          await client.query(
            "SELECT id,tenant_id FROM users WHERE lower(email)=$1 AND NOT platform_admin FOR UPDATE",
            [email],
          )
        ).rows[0];
        if (!target)
          throw new SecurityError(
            404,
            "This account is not available for administrative recovery",
          );
        if (request.action === "revoke") {
          const result = await client.query(
            "UPDATE account_recovery_tokens SET revoked_at=clock_timestamp() WHERE user_id=$1 AND kind='admin_link' AND used_at IS NULL AND revoked_at IS NULL",
            [target.id],
          );
          await recordSecurityEvent(
            client,
            target,
            "recovery_link_revoked",
            0,
            actor.id,
          );
          return { revoked: result.rowCount };
        }
        const result = await this.issue(
          client,
          target.id,
          "admin_link",
          actor.id,
        );
        await recordSecurityEvent(
          client,
          target,
          "recovery_link_created",
          0,
          actor.id,
        );
        return { ...result, email };
      },
    );
  }

  /** @param {import('pg').PoolClient} client @param {object} user @param {string} replacement @param {string|null} actor @returns {Promise<void>} */
  async replacePassword(client, user, replacement, actor) {
    await client.query(
      "UPDATE users SET password_hash=$2,password_changed_at=clock_timestamp() WHERE id=$1",
      [user.id, replacement],
    );
    const removed = await client.query(
      "DELETE FROM sessions WHERE user_id=$1",
      [user.id],
    );
    await client.query(
      "UPDATE account_recovery_tokens SET revoked_at=clock_timestamp() WHERE user_id=$1 AND used_at IS NULL AND revoked_at IS NULL",
      [user.id],
    );
    await recordSecurityEvent(
      client,
      user,
      "password_recovered",
      removed.rowCount,
      actor,
    );
  }

  /** @param {unknown} address @param {unknown} secret @param {unknown} password @returns {Promise<object>} */
  async consume(address, secret, password) {
    const email = emailAddress(address);
    const key = recoverySecret(secret);
    const token = (
      await this.pool.query(
        `SELECT r.id,r.user_id FROM account_recovery_tokens r JOIN users u ON u.id=r.user_id
      WHERE lower(u.email)=$1 AND r.token_hash=$2 AND r.used_at IS NULL AND r.revoked_at IS NULL AND (r.expires_at IS NULL OR r.expires_at>clock_timestamp())`,
        [email, tokenHash(key)],
      )
    ).rows[0];
    if (!token) throw new SecurityError(400, INVALID);
    if (
      typeof password !== "string" ||
      password.length < 8 ||
      password.length > 1024
    )
      throw new SecurityError(
        400,
        "Password must contain 8 to 1024 characters",
      );
    const replacement = await hashPassword(password);
    return this.security.withUser(token.user_id, async (client, user) => {
      const current = (
        await client.query(
          `SELECT id,kind FROM account_recovery_tokens WHERE id=$1 AND user_id=$2 AND token_hash=$3
        AND used_at IS NULL AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>clock_timestamp()) FOR UPDATE`,
          [token.id, user.id, tokenHash(key)],
        )
      ).rows[0];
      if (
        !current ||
        user.email.toLowerCase() !== email ||
        (current.kind === "admin_link" && user.platform_admin)
      )
        throw new SecurityError(400, INVALID);
      await client.query(
        "UPDATE account_recovery_tokens SET used_at=clock_timestamp() WHERE id=$1",
        [current.id],
      );
      await this.replacePassword(client, user, replacement, user.id);
      const next = await this.issue(client, user.id, "saved_key", user.id);
      await recordSecurityEvent(client, user, "recovery_key_created", 0);
      return { key: next.key, createdAt: next.createdAt };
    });
  }

  /** Server-operator entry point; never exposed by an HTTP route.
   * @param {string} address @param {string} password @returns {Promise<void>} */
  async operatorReset(address, password) {
    const email = emailAddress(address);
    const user = (
      await this.pool.query("SELECT id FROM users WHERE lower(email)=$1", [
        email,
      ])
    ).rows[0];
    if (!user) throw new SecurityError(404, "Account not found");
    const replacement = await hashPassword(password);
    await this.security.withUser(user.id, async (client, current) => {
      if (current.email.toLowerCase() !== email)
        throw new SecurityError(
          409,
          "Account security changed. Refresh and try again.",
        );
      await this.replacePassword(client, current, replacement, null);
    });
  }
}
