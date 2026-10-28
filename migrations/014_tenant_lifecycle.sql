ALTER TABLE tenants
  ADD COLUMN lifecycle text NOT NULL DEFAULT 'active' CHECK (lifecycle IN ('active','suspended')),
  ADD COLUMN lifecycle_revision bigint NOT NULL DEFAULT 0,
  ADD COLUMN lifecycle_changed_at timestamptz,
  ADD COLUMN lifecycle_message text NOT NULL DEFAULT '' CHECK (length(lifecycle_message)<=500);

CREATE TABLE tenant_lifecycle_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  revision bigint NOT NULL,
  state text NOT NULL CHECK (state IN ('active','suspended')),
  message text NOT NULL CHECK (length(message)<=500),
  actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id,revision)
);
