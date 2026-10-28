CREATE TABLE workspace_retention (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id),
  enabled boolean NOT NULL DEFAULT false,
  measurement_days integer NOT NULL DEFAULT 365 CHECK (measurement_days BETWEEN 1 AND 3650),
  activity_days integer NOT NULL DEFAULT 730 CHECK (activity_days BETWEEN 30 AND 3650),
  revision bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  next_run_at timestamptz NOT NULL DEFAULT now(),
  last_run_at timestamptz,
  last_failed_at timestamptz,
  last_counts jsonb NOT NULL DEFAULT '{}',
  CHECK (jsonb_typeof(last_counts)='object')
);
CREATE INDEX workspace_retention_due ON workspace_retention(next_run_at) WHERE enabled;
CREATE TABLE retention_policy_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  revision bigint NOT NULL,
  enabled boolean NOT NULL,
  measurement_days integer NOT NULL,
  activity_days integer NOT NULL,
  actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id,revision)
);
