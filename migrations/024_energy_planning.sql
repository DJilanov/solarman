CREATE TABLE energy_settings (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id),
  revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
  profile jsonb NOT NULL CHECK(jsonb_typeof(profile)='object'),
  automatic boolean NOT NULL DEFAULT false,
  approval_binding text,
  approved_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  attempted_at timestamptz,
  last_code text,
  CHECK(NOT automatic OR (approval_binding IS NOT NULL AND approval_binding ~ '^[a-f0-9]{64}$' AND approved_by IS NOT NULL))
);
CREATE TABLE energy_forecasts (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  site_hash text NOT NULL,
  fetched_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  payload jsonb NOT NULL,
  UNIQUE(tenant_id,id)
);
CREATE INDEX energy_forecasts_recent ON energy_forecasts(tenant_id,site_hash,fetched_at DESC);
CREATE TABLE energy_plans (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  account_id uuid NOT NULL,
  device text NOT NULL,
  binding text,
  forecast_id uuid NOT NULL,
  settings_revision bigint NOT NULL,
  profile_hash text NOT NULL,
  profile jsonb NOT NULL,
  demand jsonb NOT NULL,
  reading jsonb NOT NULL,
  prediction jsonb NOT NULL,
  state text NOT NULL CHECK(state IN('recommended','scheduled','starting','running','restoring','completed','skipped','cancelled','blocked','failed','quarantined')),
  approved_by uuid REFERENCES users(id) ON DELETE SET NULL,
  approved_snapshot jsonb,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  code text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(tenant_id,id),
  FOREIGN KEY(tenant_id,account_id) REFERENCES solarman_accounts(tenant_id,id),
  FOREIGN KEY(tenant_id,forecast_id) REFERENCES energy_forecasts(tenant_id,id),
  CHECK(ends_at>starts_at)
);
CREATE UNIQUE INDEX energy_plans_pending ON energy_plans(tenant_id) WHERE state IN('scheduled','starting','running','restoring');
CREATE INDEX energy_plans_recent ON energy_plans(tenant_id,created_at DESC);
CREATE TABLE energy_outcomes (
  tenant_id uuid NOT NULL,
  forecast_id uuid NOT NULL,
  day date NOT NULL,
  site_hash text NOT NULL,
  payload jsonb NOT NULL,
  assessed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_id,forecast_id,day),
  FOREIGN KEY(tenant_id,forecast_id) REFERENCES energy_forecasts(tenant_id,id)
);
CREATE TABLE energy_events (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  idempotency_key uuid,
  action text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(tenant_id,user_id,idempotency_key)
);
ALTER TABLE outage_preparations ADD COLUMN purpose text NOT NULL DEFAULT 'outage' CHECK(purpose IN('outage','night'));
ALTER TABLE outage_preparations ADD COLUMN ends_at timestamptz;
ALTER TABLE outage_preparations ADD COLUMN planned_windows jsonb;
ALTER TABLE outage_preparations ADD COLUMN energy_plan_id uuid;
ALTER TABLE outage_preparations ADD FOREIGN KEY(tenant_id,energy_plan_id) REFERENCES energy_plans(tenant_id,id);
ALTER TABLE outage_preparations ADD CHECK((purpose='outage' AND energy_plan_id IS NULL AND ends_at IS NULL AND planned_windows IS NULL) OR (purpose='night' AND NOT test AND energy_plan_id IS NOT NULL AND ends_at IS NOT NULL AND planned_windows IS NOT NULL AND jsonb_typeof(planned_windows)='array' AND jsonb_array_length(planned_windows)=8));
