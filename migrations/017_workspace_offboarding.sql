ALTER TABLE tenants DROP CONSTRAINT tenants_lifecycle_check;
ALTER TABLE tenants ADD CONSTRAINT tenants_lifecycle_check CHECK(lifecycle IN ('active','suspended','offboarding','removed'));
ALTER TABLE tenant_lifecycle_events DROP CONSTRAINT tenant_lifecycle_events_state_check;
ALTER TABLE tenant_lifecycle_events ADD CONSTRAINT tenant_lifecycle_events_state_check CHECK(state IN ('active','suspended','offboarding','removed'));

CREATE TABLE workspace_offboarding (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id),
  id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  requested_by uuid REFERENCES users(id) ON DELETE SET NULL,
  erasure_authorized_at timestamptz,
  offsite_acknowledged_at timestamptz,
  erasure_started_at timestamptz,
  completed_at timestamptz,
  last_failed_at timestamptz,
  last_attempted_at timestamptz,
  removed_rows bigint NOT NULL DEFAULT 0 CHECK(removed_rows>=0),
  CHECK(offsite_acknowledged_at IS NULL OR erasure_authorized_at IS NOT NULL),
  CHECK(erasure_started_at IS NULL OR offsite_acknowledged_at IS NOT NULL),
  CHECK(completed_at IS NULL OR erasure_started_at IS NOT NULL)
);
CREATE INDEX workspace_offboarding_pending ON workspace_offboarding(last_attempted_at NULLS FIRST,requested_at) WHERE erasure_authorized_at IS NOT NULL AND completed_at IS NULL;

ALTER TABLE solarman_accounts ALTER COLUMN credentials DROP NOT NULL;
ALTER TABLE api_requests ALTER COLUMN tenant_id DROP NOT NULL;
ALTER TABLE api_requests ALTER COLUMN account_id DROP NOT NULL;
ALTER TABLE api_requests ADD CONSTRAINT api_requests_anonymous_pair CHECK((tenant_id IS NULL)=(account_id IS NULL));
CREATE INDEX api_requests_anonymous_time ON api_requests(created_at) WHERE tenant_id IS NULL;
