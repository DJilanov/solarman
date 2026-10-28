CREATE TABLE account_recovery_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  kind text NOT NULL CHECK (kind IN ('saved_key','admin_link')),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  used_at timestamptz,
  revoked_at timestamptz,
  CHECK (kind='saved_key' OR expires_at IS NOT NULL)
);
CREATE UNIQUE INDEX account_recovery_active ON account_recovery_tokens (user_id,kind)
  WHERE used_at IS NULL AND revoked_at IS NULL;
CREATE INDEX account_recovery_user_time ON account_recovery_tokens (user_id,created_at DESC);

ALTER TABLE account_security_events DROP CONSTRAINT account_security_events_kind_check;
ALTER TABLE account_security_events ADD CONSTRAINT account_security_events_kind_check CHECK
  (kind IN ('signed_in','signed_out','password_changed','session_revoked','other_sessions_revoked',
    'recovery_key_created','recovery_access_revoked','recovery_link_created','recovery_link_revoked','password_recovered'));
ALTER TABLE account_security_events ADD COLUMN actor_id uuid REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE invitations ADD COLUMN id uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE invitations ADD CONSTRAINT invitations_public_id UNIQUE (id);
ALTER TABLE invitations ADD COLUMN revoked_at timestamptz;
ALTER TABLE invitations ADD COLUMN revoked_by uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE invitations ADD COLUMN replaced_by_id uuid REFERENCES invitations(id);
WITH ranked AS (
  SELECT id,first_value(id) OVER (PARTITION BY lower(email) ORDER BY created_at DESC,token_hash DESC) AS newest
  FROM invitations WHERE used_at IS NULL
)
UPDATE invitations i SET revoked_at=now(),replaced_by_id=r.newest FROM ranked r
  WHERE i.id=r.id AND i.id<>r.newest;
UPDATE invitations i SET revoked_at=now()
  WHERE used_at IS NULL AND revoked_at IS NULL AND EXISTS (SELECT 1 FROM users u WHERE lower(u.email)=lower(i.email));
CREATE UNIQUE INDEX invitations_active_email ON invitations (lower(email)) WHERE used_at IS NULL AND revoked_at IS NULL;
