import { createHash, randomUUID } from "node:crypto";
import { hashPassword, randomToken, tokenHash } from "./auth.mjs";
import { requireActiveTenant } from "./tenant-lifecycle.mjs";
import {
  AccountSecurity,
  SecurityError,
  createBrowserSession,
  recordSecurityEvent,
} from "./account-security.mjs";

/** @param {import('pg').PoolClient} client @param {string} email @returns {Promise<void>} */
export async function lockInvitationEmail(client, email) {
  const key = createHash("sha256")
    .update(email.toLowerCase())
    .digest()
    .readInt32BE(0);
  await client.query("SELECT pg_advisory_xact_lock(193402,$1)", [key]);
}

export class Invitations {
  /** @param {import('pg').Pool} pool */
  constructor(pool) {
    this.pool = pool;
    this.security = new AccountSecurity(pool);
  }

  /** @template T @param {{id:string,token_hash:string}} actor @param {(client:import('pg').PoolClient,user:object)=>Promise<T>} operation @returns {Promise<T>} */
  async admin(actor, operation) {
    return this.security.withUser(actor.id, async (client, user) => {
      await this.security.activeSession(client, actor);
      if (!user.platform_admin)
        throw new SecurityError(403, "Administrator access is required");
      await requireActiveTenant(client, user.tenant_id);
      return operation(client, user);
    });
  }

  /** @param {import('pg').PoolClient} client @param {object} actor @param {string} email @param {string} name @returns {Promise<object>} */
  async insert(client, actor, email, name) {
    const token = randomToken();
    const row = (
      await client.query(
        "INSERT INTO invitations (token_hash,email,tenant_name,created_by,created_at,expires_at) VALUES ($1,$2,$3,$4,clock_timestamp(),clock_timestamp()+interval '24 hours') RETURNING id,expires_at",
        [tokenHash(token), email, name, actor.id],
      )
    ).rows[0];
    return { token, id: row.id, expiresAt: row.expires_at };
  }

  /** @param {{id:string,token_hash:string}} actor @param {{email:unknown,tenantName:unknown}} body @returns {Promise<object>} */
  async create(actor, body) {
    if (
      typeof body.email !== "string" ||
      body.email.length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email.trim()) ||
      typeof body.tenantName !== "string" ||
      !body.tenantName.trim() ||
      body.tenantName.length > 100
    )
      throw new SecurityError(400, "Enter an email and a workspace name");
    const email = body.email.trim().toLowerCase();
    return this.admin(actor, async (client, user) => {
      await lockInvitationEmail(client, email);
      if (
        (
          await client.query("SELECT 1 FROM users WHERE lower(email)=$1", [
            email,
          ])
        ).rowCount
      )
        throw new SecurityError(409, "This email already has an account");
      if (
        (
          await client.query(
            "SELECT 1 FROM invitations WHERE lower(email)=$1 AND used_at IS NULL AND revoked_at IS NULL",
            [email],
          )
        ).rowCount
      )
        throw new SecurityError(
          409,
          "An invitation already exists for this email. Reissue it from invitation history.",
        );
      return this.insert(client, user, email, body.tenantName.trim());
    });
  }

  /** @param {{id:string,token_hash:string}} actor @param {string} id @param {'revoke'|'reissue'} action @returns {Promise<object>} */
  async change(actor, id, action) {
    if (!["revoke", "reissue"].includes(action))
      throw new SecurityError(400, "Choose a valid invitation action");
    if (
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)
    )
      throw new SecurityError(400, "Choose a valid invitation");
    return this.admin(actor, async (client, user) => {
      const original = (
        await client.query("SELECT email FROM invitations WHERE id=$1", [id])
      ).rows[0];
      if (!original) throw new SecurityError(404, "Invitation not found");
      await lockInvitationEmail(client, original.email);
      const row = (
        await client.query("SELECT * FROM invitations WHERE id=$1 FOR UPDATE", [
          id,
        ])
      ).rows[0];
      if (!row) throw new SecurityError(404, "Invitation not found");
      if (row.used_at)
        throw new SecurityError(
          409,
          "This invitation has already been accepted",
        );
      if (row.replaced_by_id)
        throw new SecurityError(
          409,
          "A newer invitation exists. Refresh invitation history.",
        );
      if (action === "revoke") {
        await client.query(
          "UPDATE invitations SET revoked_at=COALESCE(revoked_at,clock_timestamp()),revoked_by=COALESCE(revoked_by,$2) WHERE id=$1",
          [id, user.id],
        );
        return { revoked: true };
      }
      const latest = (
        await client.query(
          "SELECT id FROM invitations WHERE lower(email)=$1 ORDER BY created_at DESC,id DESC LIMIT 1",
          [row.email.toLowerCase()],
        )
      ).rows[0];
      if (latest.id !== id)
        throw new SecurityError(
          409,
          "A newer invitation exists. Refresh invitation history.",
        );
      if (
        (
          await client.query("SELECT 1 FROM users WHERE lower(email)=$1", [
            row.email,
          ])
        ).rowCount
      )
        throw new SecurityError(409, "This email already has an account");
      await client.query(
        "UPDATE invitations SET revoked_at=COALESCE(revoked_at,clock_timestamp()),revoked_by=COALESCE(revoked_by,$2) WHERE id=$1",
        [id, user.id],
      );
      const next = await this.insert(client, user, row.email, row.tenant_name);
      await client.query(
        "UPDATE invitations SET replaced_by_id=$2 WHERE id=$1",
        [id, next.id],
      );
      return next;
    });
  }

  /** @param {unknown} token @returns {Promise<object>} */
  async inspect(token) {
    if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token))
      throw new SecurityError(404, "Invitation is invalid or expired");
    const row = (
      await this.pool.query(
        "SELECT email,tenant_name FROM invitations WHERE token_hash=$1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at>clock_timestamp()",
        [tokenHash(token)],
      )
    ).rows[0];
    if (!row) throw new SecurityError(404, "Invitation is invalid or expired");
    return row;
  }

  /** @param {unknown} token @param {unknown} password @param {unknown} agent @returns {Promise<object>} */
  async activate(token, password, agent) {
    let inspected;
    try {
      inspected = await this.inspect(token);
    } catch (error) {
      if (error instanceof SecurityError && error.status === 404)
        throw new SecurityError(400, error.message);
      throw error;
    }
    if (
      typeof password !== "string" ||
      password.length < 8 ||
      password.length > 1024
    )
      throw new SecurityError(
        400,
        "Use a valid invitation and a password of at least 8 characters",
      );
    const replacement = await hashPassword(password);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockInvitationEmail(client, inspected.email);
      const invitation = (
        await client.query(
          "SELECT * FROM invitations WHERE token_hash=$1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at>clock_timestamp() FOR UPDATE",
          [tokenHash(token)],
        )
      ).rows[0];
      if (!invitation)
        throw new SecurityError(400, "Invitation is invalid or expired");
      const tenant = randomUUID(),
        id = randomUUID();
      await client.query("INSERT INTO tenants (id,name) VALUES ($1,$2)", [
        tenant,
        invitation.tenant_name,
      ]);
      await client.query(
        "INSERT INTO users (id,tenant_id,email,password_hash) VALUES ($1,$2,$3,$4)",
        [id, tenant, invitation.email, replacement],
      );
      await client.query(
        "INSERT INTO controller_state (tenant_id) VALUES ($1)",
        [tenant],
      );
      await client.query(
        "UPDATE invitations SET used_at=clock_timestamp() WHERE id=$1",
        [invitation.id],
      );
      const session = await createBrowserSession(client, id, agent);
      const user = {
        id,
        email: invitation.email,
        tenant_id: tenant,
        tenant_name: invitation.tenant_name,
        platform_admin: false,
      };
      await recordSecurityEvent(client, user, "signed_in", 1);
      await client.query("COMMIT");
      return { user, ...session };
    } catch (error) {
      await client.query("ROLLBACK");
      if (error?.code === "23505")
        throw new SecurityError(
          409,
          "This account already exists. Sign in instead.",
        );
      throw error;
    } finally {
      client.release();
    }
  }

  /** @param {number} offset @returns {Promise<object>} */
  async list(offset) {
    const rows = (
      await this.pool.query(
        `SELECT id,email,tenant_name,created_at,expires_at,used_at,revoked_at,replaced_by_id,
      CASE WHEN used_at IS NOT NULL THEN 'accepted' WHEN replaced_by_id IS NOT NULL THEN 'replaced' WHEN revoked_at IS NOT NULL THEN 'revoked' WHEN expires_at<=clock_timestamp() THEN 'expired' ELSE 'pending' END AS status
      FROM invitations ORDER BY created_at DESC,id DESC LIMIT 21 OFFSET $1`,
        [offset],
      )
    ).rows;
    return { items: rows.slice(0, 20), hasMore: rows.length > 20, offset };
  }
}
