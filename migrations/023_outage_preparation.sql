CREATE TABLE outage_preparations (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  account_id uuid NOT NULL,
  device text NOT NULL,
  binding text NOT NULL CHECK(binding ~ '^[a-f0-9]{64}$'),
  mapping text NOT NULL,
  target_soc integer NOT NULL CHECK(target_soc BETWEEN 50 AND 100),
  state text NOT NULL CHECK(state IN('queued','applying','active','restoring','recovery-required','restored','failed','quarantined')),
  revision bigint NOT NULL DEFAULT 1 CHECK(revision > 0),
  test boolean NOT NULL DEFAULT false,
  attended_until timestamptz,
  baseline jsonb,
  proof jsonb NOT NULL DEFAULT '{}',
  approved_at timestamptz,
  approved_by uuid REFERENCES users(id) ON DELETE SET NULL,
  command_id uuid,
  command_epoch bigint NOT NULL,
  last_verified_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ended_at timestamptz,
  UNIQUE(tenant_id,id),
  FOREIGN KEY(tenant_id,account_id) REFERENCES solarman_accounts(tenant_id,id),
  FOREIGN KEY(tenant_id,command_id) REFERENCES command_executions(tenant_id,id),
  CHECK(approved_at IS NULL OR (test AND state='restored' AND baseline IS NOT NULL)),
  CHECK(NOT test OR attended_until IS NOT NULL)
);
CREATE UNIQUE INDEX outage_preparations_active ON outage_preparations(tenant_id)
  WHERE state IN('queued','applying','active','restoring','recovery-required','quarantined');
CREATE INDEX outage_preparations_binding ON outage_preparations(tenant_id,account_id,device,created_at DESC);

CREATE TABLE outage_write_intents (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  preparation_id uuid NOT NULL,
  execution_id uuid NOT NULL,
  revision bigint NOT NULL,
  phase text NOT NULL CHECK(phase IN('apply','restore')),
  address integer NOT NULL CHECK(address IN(206,2500,2505,2509)),
  register_values jsonb NOT NULL CHECK(jsonb_typeof(register_values)='array'),
  status text NOT NULL DEFAULT 'prepared' CHECK(status IN('prepared','acknowledged','verified','uncertain')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  acknowledged_at timestamptz,
  verified_at timestamptz,
  reconciled_at timestamptz,
  FOREIGN KEY(tenant_id,execution_id) REFERENCES command_executions(tenant_id,id),
  FOREIGN KEY(tenant_id,preparation_id) REFERENCES outage_preparations(tenant_id,id)
);
CREATE INDEX outage_write_intents_preparation ON outage_write_intents(tenant_id,preparation_id,created_at,id);
