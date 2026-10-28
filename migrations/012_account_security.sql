ALTER TABLE sessions ADD COLUMN id uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE sessions ADD CONSTRAINT sessions_public_id UNIQUE (id);
ALTER TABLE sessions ADD COLUMN user_agent varchar(256) NOT NULL DEFAULT '';
ALTER TABLE sessions ADD COLUMN last_seen_at timestamptz;
CREATE INDEX sessions_user_created ON sessions (user_id,created_at DESC);
ALTER TABLE users ADD COLUMN password_changed_at timestamptz;

CREATE TABLE account_security_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('signed_in','signed_out','password_changed','session_revoked','other_sessions_revoked')),
  affected_sessions integer NOT NULL CHECK (affected_sessions >= 0),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,user_id) REFERENCES users(tenant_id,id) ON DELETE CASCADE
);
CREATE INDEX account_security_events_user_time ON account_security_events (user_id,occurred_at DESC,id DESC);
