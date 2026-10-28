ALTER TABLE measurements ADD COLUMN control_binding text CHECK(control_binding IS NULL OR control_binding ~ '^[a-f0-9]{64}$');
CREATE INDEX measurements_observation_cursor ON measurements(tenant_id,id);

CREATE TABLE policy_observation_runs (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  account_id uuid NOT NULL,
  device text NOT NULL,
  binding text NOT NULL CHECK(binding ~ '^[a-f0-9]{64}$'),
  identity jsonb NOT NULL,
  verification jsonb NOT NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  state text NOT NULL DEFAULT 'observing' CHECK(state IN('observing','stopped','invalidated')),
  reason text,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ended_at timestamptz,
  checked_at timestamptz,
  failed_at timestamptz,
  cursor_id bigint NOT NULL CHECK(cursor_id>=0),
  progress jsonb NOT NULL,
  FOREIGN KEY(tenant_id,account_id) REFERENCES solarman_accounts(tenant_id,id),
  CHECK((state='observing')=(ended_at IS NULL))
);
CREATE UNIQUE INDEX policy_observation_active ON policy_observation_runs(tenant_id) WHERE state='observing';
CREATE INDEX policy_observation_history ON policy_observation_runs(tenant_id,started_at DESC,id);
CREATE INDEX policy_observation_due ON policy_observation_runs(checked_at NULLS FIRST) WHERE state='observing';
