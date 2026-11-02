import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import { randomToken, tokenHash } from "./auth.mjs";
import {
  AccountSecurity,
  SecurityError,
  browserDescription,
  createBrowserSession,
  recordSecurityEvent,
} from "./account-security.mjs";

const INVALID =
  "Passkey verification failed. Start again and try your passkey.";
const ALGORITHMS = [-7, -257];

/** @typedef {{id:string,tenant_id:string,email:string,password_hash:string,platform_admin:boolean}} PasskeyUser */
/** @typedef {{id:string,token_hash:string}} PasskeySession */
/** @typedef {{token:string,csrfToken:string}} BrowserLogin */

/** @param {unknown} value @returns {string} */
function challengeToken(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
    throw new SecurityError(400, INVALID);
  return value;
}

/** @param {unknown} value @returns {object} */
function credentialResponse(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    typeof value.id !== "string" ||
    value.id.length > 2048 ||
    value.type !== "public-key" ||
    !value.response ||
    typeof value.response !== "object"
  )
    throw new SecurityError(400, INVALID);
  return value;
}

export class Passkeys {
  /** @param {import('pg').Pool} pool @param {string} origin */
  constructor(pool, origin) {
    this.pool = pool;
    this.security = new AccountSecurity(pool);
    this.origin = origin;
    this.rpID = new URL(origin).hostname;
  }

  /** @param {import('pg').PoolClient} client @param {string} userId @returns {Promise<object[]>} */
  async keys(client, userId) {
    return (
      await client.query(
        "SELECT * FROM account_passkeys WHERE user_id=$1 ORDER BY created_at,id",
        [userId],
      )
    ).rows;
  }

  /** @param {import('pg').PoolClient} client @param {PasskeyUser} user @returns {Promise<void>} */
  async registrationReady(client, user) {
    const ready = (
      await client.query(
        "SELECT password_changed_at,EXISTS(SELECT 1 FROM account_recovery_tokens r WHERE r.user_id=u.id AND r.kind='saved_key' AND r.used_at IS NULL AND r.revoked_at IS NULL) AS recovery FROM users u WHERE u.id=$1",
        [user.id],
      )
    ).rows[0];
    if (user.platform_admin && !ready.password_changed_at)
      throw new SecurityError(
        409,
        "Change the initial administrator password before adding a passkey",
      );
    if (!ready.recovery)
      throw new SecurityError(
        409,
        "Create and save your recovery key before adding a passkey",
      );
    if ((await this.keys(client, user.id)).length >= 8)
      throw new SecurityError(
        409,
        "Remove an old passkey before adding another",
      );
  }

  /** @param {import('pg').PoolClient} client @param {PasskeyUser} user @param {'register'|'login'} purpose @param {{challenge:string}} options @param {unknown} agent @param {PasskeySession|null} [session] @param {string|null} [name] @returns {Promise<object>} */
  async saveChallenge(
    client,
    user,
    purpose,
    options,
    agent,
    session = null,
    name = null,
  ) {
    await client.query(
      "DELETE FROM account_passkey_challenges WHERE user_id=$1 AND expires_at<=clock_timestamp()",
      [user.id],
    );
    const count = (
      await client.query(
        "SELECT count(*)::integer AS n FROM account_passkey_challenges WHERE user_id=$1",
        [user.id],
      )
    ).rows[0].n;
    if (count >= 8)
      throw new SecurityError(
        429,
        "Too many passkey attempts. Wait five minutes and try again.",
      );
    const token = randomToken();
    await client.query(
      "INSERT INTO account_passkey_challenges(token_hash,tenant_id,user_id,purpose,challenge,password_fingerprint,agent_fingerprint,session_token_hash,name) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [
        tokenHash(token),
        user.tenant_id,
        user.id,
        purpose,
        options.challenge,
        tokenHash(user.password_hash),
        tokenHash(browserDescription(agent)),
        session?.token_hash ?? null,
        name,
      ],
    );
    return { challengeToken: token, options };
  }

  /** @param {PasskeyUser} verified @param {unknown} agent @returns {Promise<object>} */
  async login(verified, agent) {
    return this.security.withUser(verified.id, async (client, user) => {
      if (user.password_hash !== verified.password_hash)
        throw new SecurityError(401, "Email or password is incorrect");
      const keys = await this.keys(client, user.id);
      if (!keys.length) {
        const result = await createBrowserSession(client, user.id, agent);
        await recordSecurityEvent(client, user, "signed_in", 1);
        return { ...result, mfaRequired: false };
      }
      const options = await generateAuthenticationOptions({
        rpID: this.rpID,
        userVerification: "required",
        timeout: 120000,
        allowCredentials: keys.map((key) => ({
          id: key.credential_id,
          transports: key.transports,
        })),
      });
      return {
        mfaRequired: true,
        ...(await this.saveChallenge(client, user, "login", options, agent)),
      };
    });
  }

  /** @param {PasskeySession} session @param {unknown} password @param {unknown} name @param {unknown} agent @returns {Promise<object>} */
  async beginRegistration(session, password, name, agent) {
    if (typeof name !== "string" || !name.trim() || name.trim().length > 80)
      throw new SecurityError(
        400,
        "Give this passkey a name of up to 80 characters",
      );
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
      await this.registrationReady(client, user);
      const keys = await this.keys(client, user.id);
      const options = await generateRegistrationOptions({
        rpName: "Solarman · JILANOVI",
        rpID: this.rpID,
        userID: new Uint8Array(Buffer.from(user.id)),
        userName: user.email,
        attestationType: "none",
        supportedAlgorithmIDs: ALGORITHMS,
        authenticatorSelection: {
          residentKey: "required",
          userVerification: "required",
        },
        excludeCredentials: keys.map((key) => ({
          id: key.credential_id,
          transports: key.transports,
        })),
        timeout: 120000,
      });
      return this.saveChallenge(
        client,
        user,
        "register",
        options,
        agent,
        session,
        name.trim(),
      );
    });
  }

  /** @param {import('pg').PoolClient} client @param {PasskeyUser} user @param {string} token @param {'register'|'login'} purpose @param {unknown} agent @param {PasskeySession|null} [session] @returns {Promise<object>} */
  async pending(client, user, token, purpose, agent, session = null) {
    const row = (
      await client.query(
        "SELECT * FROM account_passkey_challenges WHERE token_hash=$1 AND user_id=$2 AND purpose=$3 AND expires_at>clock_timestamp() FOR UPDATE",
        [tokenHash(token), user.id, purpose],
      )
    ).rows[0];
    if (
      !row ||
      row.password_fingerprint !== tokenHash(user.password_hash) ||
      row.agent_fingerprint !== tokenHash(browserDescription(agent)) ||
      (purpose === "register" && row.session_token_hash !== session?.token_hash)
    )
      throw new SecurityError(400, INVALID);
    return row;
  }

  /** @param {import('pg').PoolClient} client @param {string} token @returns {Promise<void>} */
  async consume(client, token) {
    const consumed = await client.query(
      "DELETE FROM account_passkey_challenges WHERE token_hash=$1 AND expires_at>clock_timestamp() RETURNING token_hash",
      [tokenHash(token)],
    );
    if (!consumed.rowCount) throw new SecurityError(400, INVALID);
  }

  /** @param {PasskeySession} session @param {unknown} tokenValue @param {unknown} responseValue @param {unknown} agent @returns {Promise<BrowserLogin>} */
  async finishRegistration(session, tokenValue, responseValue, agent) {
    const token = challengeToken(tokenValue),
      response = credentialResponse(responseValue);
    return this.security.withUser(session.id, async (client, user) => {
      const current = await this.security.activeSession(client, session);
      await this.registrationReady(client, user);
      const pending = await this.pending(
        client,
        user,
        token,
        "register",
        agent,
        session,
      );
      let result;
      try {
        result = await verifyRegistrationResponse({
          response,
          expectedChallenge: pending.challenge,
          expectedOrigin: this.origin,
          expectedRPID: this.rpID,
          requireUserVerification: true,
          requireUserPresence: true,
          supportedAlgorithmIDs: ALGORITHMS,
        });
      } catch {
        throw new SecurityError(400, INVALID);
      }
      if (!result.verified) throw new SecurityError(400, INVALID);
      const { credential, credentialDeviceType, credentialBackedUp } =
        result.registrationInfo;
      const transports = Array.isArray(credential.transports)
        ? credential.transports
            .filter((item) => typeof item === "string" && item.length <= 32)
            .slice(0, 8)
        : [];
      const inserted = await client.query(
        "INSERT INTO account_passkeys(tenant_id,user_id,credential_id,public_key,counter,transports,device_type,backed_up,name) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(credential_id) DO NOTHING RETURNING id",
        [
          user.tenant_id,
          user.id,
          credential.id,
          Buffer.from(credential.publicKey),
          credential.counter,
          transports,
          credentialDeviceType,
          credentialBackedUp,
          pending.name,
        ],
      );
      if (!inserted.rowCount)
        throw new SecurityError(409, "This passkey is already registered");
      await this.consume(client, token);
      await client.query(
        "DELETE FROM account_passkey_challenges WHERE user_id=$1",
        [user.id],
      );
      await client.query("UPDATE users SET mfa_required=true WHERE id=$1", [
        user.id,
      ]);
      const removed = await client.query(
        "DELETE FROM sessions WHERE user_id=$1",
        [user.id],
      );
      const next = await createBrowserSession(client, user.id, agent, {
        id: current.id,
        createdAt: current.created_at,
        mfaVerified: true,
      });
      await recordSecurityEvent(
        client,
        user,
        "passkey_added",
        removed.rowCount,
      );
      return next;
    });
  }

  /** @param {unknown} tokenValue @param {unknown} responseValue @param {unknown} agent @returns {Promise<BrowserLogin>} */
  async finishLogin(tokenValue, responseValue, agent) {
    const token = challengeToken(tokenValue),
      response = credentialResponse(responseValue);
    const pending = (
      await this.pool.query(
        "SELECT user_id FROM account_passkey_challenges WHERE token_hash=$1 AND purpose='login' AND expires_at>clock_timestamp()",
        [tokenHash(token)],
      )
    ).rows[0];
    if (!pending) throw new SecurityError(400, INVALID);
    return this.security.withUser(pending.user_id, async (client, user) => {
      const challenge = await this.pending(client, user, token, "login", agent);
      const key = (await this.keys(client, user.id)).find(
        (item) => item.credential_id === response.id,
      );
      if (!key) throw new SecurityError(400, INVALID);
      let result;
      try {
        result = await verifyAuthenticationResponse({
          response,
          expectedChallenge: challenge.challenge,
          expectedOrigin: this.origin,
          expectedRPID: this.rpID,
          requireUserVerification: true,
          credential: {
            id: key.credential_id,
            publicKey: new Uint8Array(key.public_key),
            counter: Number(key.counter),
            transports: key.transports,
          },
        });
      } catch {
        throw new SecurityError(400, INVALID);
      }
      if (!result.verified) throw new SecurityError(400, INVALID);
      await this.consume(client, token);
      await client.query(
        "UPDATE account_passkeys SET counter=$2,last_used_at=clock_timestamp(),backed_up=$3 WHERE id=$1",
        [
          key.id,
          result.authenticationInfo.newCounter,
          result.authenticationInfo.credentialBackedUp,
        ],
      );
      const session = await createBrowserSession(client, user.id, agent, {
        mfaVerified: true,
      });
      await recordSecurityEvent(client, user, "signed_in", 1);
      return session;
    });
  }

  /** @param {PasskeySession} session @param {unknown} password @param {unknown} id @returns {Promise<{removed:boolean}>} */
  async remove(session, password, id) {
    if (typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id))
      throw new SecurityError(400, "Choose a valid passkey");
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
      const keys = await this.keys(client, user.id);
      if (!keys.some((key) => key.id === id))
        throw new SecurityError(404, "Passkey not found");
      if (keys.length < 2)
        throw new SecurityError(
          409,
          "Add another passkey before removing your last one",
        );
      await client.query(
        "DELETE FROM account_passkeys WHERE id=$1 AND user_id=$2",
        [id, user.id],
      );
      await client.query(
        "DELETE FROM account_passkey_challenges WHERE user_id=$1",
        [user.id],
      );
      const removed = await client.query(
        "DELETE FROM sessions WHERE user_id=$1 AND token_hash<>$2",
        [user.id, session.token_hash],
      );
      await recordSecurityEvent(
        client,
        user,
        "passkey_removed",
        removed.rowCount,
      );
      return { removed: true };
    });
  }
}
