import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { hashPassword, randomToken, tokenHash } from "../../src/auth.mjs";
import { createApp } from "../../src/http-app.mjs";
import { passkeyAuthenticator } from "../fixtures/passkeys.mjs";

export function registerPasskeyIntegration({ getPool }) {
  const password = "passkey-integration-fixture-password";
  async function fixture() {
    const pool = getPool(),
      user = randomUUID(),
      tenant = randomUUID(),
      email = `${user}@example.test`;
    await pool.query("INSERT INTO tenants(id,name) VALUES($1,'Passkey test')", [
      tenant,
    ]);
    await pool.query(
      "INSERT INTO users(id,tenant_id,email,password_hash,platform_admin) VALUES($1,$2,$3,$4,true)",
      [user, tenant, email, await hashPassword(password)],
    );
    const app = createApp({
      pool,
      hub: { offboarding: {} },
      config: { origin: "http://localhost", secure: true },
    });
    const server = createServer((req, res) => {
      void app(req, res);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const agent = "passkey-integration";
    const request = (
      route,
      {
        auth = null,
        body,
        csrf = true,
        headers = {},
        method = body ? "POST" : "GET",
      } = {},
    ) =>
      fetch(origin + "/api" + route, {
        method,
        headers: {
          origin: "http://localhost",
          "user-agent": agent,
          ...(body ? { "content-type": "application/json" } : {}),
          ...(auth
            ? {
                cookie: auth.cookie,
                ...(csrf ? { "x-csrf-token": auth.csrfToken } : {}),
              }
            : {}),
          ...headers,
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    const session = async (response) => {
      assert.equal(response.status, 200, await response.clone().text());
      return {
        ...(await response.json()),
        cookie: response.headers.get("set-cookie").split(";")[0],
      };
    };
    const login = () => request("/auth/login", { body: { email, password } });
    let auth = await session(await login());
    const prepare = async (name = "Fixture passkey") => {
      const response = await request("/security/passkeys/options", {
        auth,
        body: { currentPassword: password, name },
      });
      assert.equal(response.status, 200, await response.clone().text());
      return response.json();
    };
    const ready = async () => {
      await pool.query(
        "UPDATE users SET password_changed_at=clock_timestamp() WHERE id=$1",
        [user],
      );
      const response = await request("/security/recovery/key", {
        auth,
        body: { currentPassword: password },
      });
      assert.equal(response.status, 200, await response.clone().text());
      return (await response.json()).key;
    };
    const enroll = async (device = passkeyAuthenticator(), name) => {
      const options = await prepare(name);
      const old = auth;
      auth = await session(
        await request("/security/passkeys/register", {
          auth,
          body: {
            challengeToken: options.challengeToken,
            response: device.registration(options.options, "http://localhost"),
          },
        }),
      );
      return { device, old, auth, options };
    };
    return {
      pool,
      user,
      tenant,
      email,
      request,
      login,
      session,
      prepare,
      ready,
      enroll,
      auth: () => auth,
      dispose: () =>
        new Promise((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
    };
  }

  test("passkey MFA requires hardened admin setup, signs real assertions and revokes password-only sessions", async () => {
    const f = await fixture();
    try {
      const initial = f.auth();
      assert.equal(
        (await f.request("/admin/invitations", { auth: initial, body: {} }))
          .status,
        403,
      );
      assert.equal(
        (
          await f.request("/security/passkeys/options", {
            auth: initial,
            body: { currentPassword: password, name: "Phone" },
          })
        ).status,
        409,
      );
      await f.ready();
      const { device } = await f.enroll();
      assert.equal(
        (await f.request("/auth/session", { auth: initial })).status,
        401,
      );
      const login = await f.login();
      assert.equal(login.status, 202);
      assert.equal(login.headers.get("set-cookie"), null);
      const challenge = await login.json();
      assert.equal(challenge.mfaRequired, true);
      assert.equal(challenge.options.userVerification, "required");
      const assertion = device.authentication(
        challenge.options,
        "http://localhost",
      );
      const results = await Promise.all([1, 2].map(() => f.request("/auth/passkey", {
          body: {
            challengeToken: challenge.challengeToken,
            response: assertion,
          },
        })));
      assert.deepEqual(results.map(result => result.status).sort(), [200, 400]);
      const confirmed = await f.session(results.find(result => result.status === 200));
      assert.equal(confirmed.security.mfaVerified, true);
      assert.equal(confirmed.security.adminSetupRequired, false);
      const legacyToken = randomToken();
      await f.pool.query("INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')", [tokenHash(legacyToken), f.user, randomToken()]);
      assert.equal((await f.request("/auth/session", { headers: { cookie: `__Host-solarman_session=${legacyToken}` } })).status, 401);
      assert.equal(
        (
          await f.request("/auth/passkey", {
            body: {
              challengeToken: challenge.challengeToken,
              response: assertion,
            },
          })
        ).status,
        400,
      );
      const status = await (
        await f.request("/security", { auth: confirmed })
      ).json();
      assert.equal(status.passkeys.length, 1);
      assert.ok(status.passkeys[0].lastUsedAt);
      assert.equal(JSON.stringify(status).includes(device.id), false);
      assert.equal(
        (
          await f.request("/security/passkeys/remove", {
            auth: confirmed,
            body: { id: status.passkeys[0].id, currentPassword: password },
          })
        ).status,
        409,
      );
      const changed = await f.session(
        await f.request("/security/password", {
          auth: confirmed,
          body: {
            currentPassword: password,
            newPassword: password + "-changed",
          },
        }),
      );
      assert.equal(changed.security.mfaVerified, true);
      assert.equal(
        (await f.request("/auth/session", { auth: confirmed })).status,
        401,
      );
    } finally {
      await f.dispose();
    }
  });

  test("removing a secondary passkey revokes other browsers and pending login challenges", async () => {
    const f = await fixture();
    try {
      await f.ready();
      await f.enroll(passkeyAuthenticator(), "First key");
      const { device } = await f.enroll(passkeyAuthenticator(), "Second key");
      const challenge = await (await f.login()).json();
      const other = await f.session(await f.request("/auth/passkey", { body: {
        challengeToken: challenge.challengeToken,
        response: device.authentication(challenge.options, "http://localhost"),
      } }));
      await f.login();
      const status = await (await f.request("/security", { auth: f.auth() })).json();
      const secondary = status.passkeys.find(key => key.name === "Second key");
      assert.equal((await f.request("/security/passkeys/remove", { auth: f.auth(), body: { id: secondary.id, currentPassword: password } })).status, 200);
      assert.equal((await f.request("/auth/session", { auth: other })).status, 401);
      assert.equal((await f.request("/auth/session", { auth: f.auth() })).status, 200);
      assert.equal((await f.pool.query("SELECT 1 FROM account_passkey_challenges WHERE user_id=$1", [f.user])).rowCount, 0);
      assert.equal((await f.pool.query("SELECT 1 FROM account_passkeys WHERE user_id=$1", [f.user])).rowCount, 1);
    } finally {
      await f.dispose();
    }
  });

  test("passkey MFA rejects wrong origins, RP IDs, missing user verification, changed browsers and expired challenges", async () => {
    const f = await fixture();
    try {
      await f.ready();
      const { device } = await f.enroll();
      for (const type of [
        "origin",
        "rp",
        "uv",
        "agent",
        "expiry",
        "password",
      ]) {
        const challenge = await (await f.login()).json();
        const assertion = device.authentication(
          challenge.options,
          type === "origin" ? "https://evil.example" : "http://localhost",
          {
            verified: type !== "uv",
            ...(type === "rp" ? { rpID: "evil.example" } : {}),
          },
        );
        if (type === "expiry")
          await f.pool.query(
            "UPDATE account_passkey_challenges SET expires_at=clock_timestamp()-interval '1 second' WHERE user_id=$1",
            [f.user],
          );
        if (type === "password")
          await f.pool.query(
            "UPDATE account_passkey_challenges SET password_fingerprint=repeat('0',64) WHERE user_id=$1",
            [f.user],
          );
        const result = await f.request("/auth/passkey", {
          body: {
            challengeToken: challenge.challengeToken,
            response: assertion,
          },
          ...(type === "agent"
            ? { headers: { "user-agent": "another browser" } }
            : {}),
        });
        assert.equal(result.status, 400, type);
        assert.equal(result.headers.get("set-cookie"), null);
        await f.pool.query(
          "DELETE FROM account_passkey_challenges WHERE user_id=$1",
          [f.user],
        );
      }
    } finally {
      await f.dispose();
    }
  });

  test("passkey registration checks CSRF and signed origin; account recovery resets MFA without opening the workspace", async () => {
    const f = await fixture();
    try {
      const key = await f.ready();
      assert.equal(
        (
          await f.request("/security/passkeys/options", {
            auth: f.auth(),
            csrf: false,
            body: { currentPassword: password, name: "Phone" },
          })
        ).status,
        403,
      );
      const options = await f.prepare();
      const device = passkeyAuthenticator();
      assert.equal(
        (
          await f.request("/security/passkeys/register", {
            auth: f.auth(),
            body: {
              challengeToken: options.challengeToken,
              response: device.registration(
                options.options,
                "https://evil.example",
              ),
            },
          })
        ).status,
        400,
      );
      await f.enroll(device);
      const recovered = await f.request("/auth/recover", {
        body: { email: f.email, key, newPassword: password + "-recovered" },
      });
      assert.equal(recovered.status, 200, await recovered.clone().text());
      const reset = await f.session(
        await f.request("/auth/login", {
          body: { email: f.email, password: password + "-recovered" },
        }),
      );
      assert.equal(reset.security.passkeyEnrollmentRequired, true);
      assert.equal(
        (await f.request("/admin/tenants", { auth: reset })).status,
        403,
      );
      assert.equal((await f.request("/security", { auth: reset })).status, 200);
      assert.equal(
        (
          await f.pool.query(
            "SELECT count(*)::integer AS n FROM account_passkeys WHERE user_id=$1",
            [f.user],
          )
        ).rows[0].n,
        0,
      );
      assert.equal(
        (
          await f.pool.query(
            "SELECT count(*)::integer AS n FROM account_passkey_challenges WHERE user_id=$1",
            [f.user],
          )
        ).rows[0].n,
        0,
      );
      const prepared = await f.request("/security/passkeys/options", {
        auth: reset,
        body: { currentPassword: password + "-recovered", name: "Recovered phone" },
      });
      assert.equal(prepared.status, 200);
      const fresh = await prepared.json();
      const restored = await f.session(await f.request("/security/passkeys/register", {
        auth: reset,
        body: { challengeToken: fresh.challengeToken, response: passkeyAuthenticator().registration(fresh.options, "http://localhost") },
      }));
      assert.equal(restored.security.passkeyEnrollmentRequired, false);
      assert.equal(restored.security.mfaVerified, true);
      assert.equal((await f.request("/auth/session", { auth: reset })).status, 401);
    } finally {
      await f.dispose();
    }
  });
}
