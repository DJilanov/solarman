ALTER TABLE sessions ADD COLUMN mfa_verified_at timestamptz;
ALTER TABLE users ADD COLUMN mfa_required boolean NOT NULL DEFAULT false;

CREATE TABLE account_passkeys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  credential_id text NOT NULL UNIQUE CHECK(length(credential_id) BETWEEN 1 AND 2048),
  public_key bytea NOT NULL,
  counter bigint NOT NULL CHECK(counter>=0),
  transports text[] NOT NULL DEFAULT '{}',
  device_type text NOT NULL CHECK(device_type IN ('singleDevice','multiDevice')),
  backed_up boolean NOT NULL,
  name varchar(80) NOT NULL CHECK(length(trim(name))>0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_used_at timestamptz,
  FOREIGN KEY (tenant_id,user_id) REFERENCES users(tenant_id,id) ON DELETE CASCADE
);
CREATE INDEX account_passkeys_user ON account_passkeys(user_id,created_at,id);

CREATE TABLE account_passkey_challenges (
  token_hash text PRIMARY KEY CHECK(token_hash ~ '^[a-f0-9]{64}$'),
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  purpose text NOT NULL CHECK(purpose IN ('register','login')),
  challenge text NOT NULL,
  password_fingerprint text NOT NULL CHECK(password_fingerprint ~ '^[a-f0-9]{64}$'),
  agent_fingerprint text NOT NULL CHECK(agent_fingerprint ~ '^[a-f0-9]{64}$'),
  session_token_hash text REFERENCES sessions(token_hash) ON DELETE CASCADE,
  name varchar(80),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '5 minutes',
  FOREIGN KEY (tenant_id,user_id) REFERENCES users(tenant_id,id) ON DELETE CASCADE,
  CHECK((purpose='register' AND session_token_hash IS NOT NULL AND name IS NOT NULL) OR
        (purpose='login' AND session_token_hash IS NULL AND name IS NULL))
);
CREATE INDEX account_passkey_challenges_expiry ON account_passkey_challenges(expires_at);

ALTER TABLE account_security_events DROP CONSTRAINT account_security_events_kind_check;
ALTER TABLE account_security_events ADD CONSTRAINT account_security_events_kind_check CHECK
  (kind IN ('signed_in','signed_out','password_changed','session_revoked','other_sessions_revoked',
    'recovery_key_created','recovery_access_revoked','recovery_link_created','recovery_link_revoked',
    'password_recovered','passkey_added','passkey_removed','passkeys_reset'));
