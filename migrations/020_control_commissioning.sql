CREATE TABLE control_commissioning (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  account_id uuid NOT NULL,
  device text NOT NULL,
  binding text NOT NULL CHECK(binding ~ '^[a-f0-9]{64}$'),
  identity jsonb NOT NULL,
  verification jsonb NOT NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  state text NOT NULL DEFAULT 'preparing' CHECK(state IN('preparing','attending','approved','invalidated')),
  revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
  attended_until timestamptz,
  evidence jsonb NOT NULL DEFAULT '{}',
  reason text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ended_at timestamptz,
  FOREIGN KEY(tenant_id,account_id) REFERENCES solarman_accounts(tenant_id,id),
  UNIQUE(tenant_id,id),
  CHECK((state='attending')=(attended_until IS NOT NULL)),
  CHECK((state='invalidated')=(ended_at IS NOT NULL))
);
CREATE UNIQUE INDEX control_commissioning_current ON control_commissioning(tenant_id) WHERE state<>'invalidated';
CREATE INDEX control_commissioning_history ON control_commissioning(tenant_id,created_at DESC,id);
CREATE INDEX control_commissioning_expiry ON control_commissioning(attended_until) WHERE state='attending';

CREATE TABLE commissioning_events (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  run_id uuid NOT NULL,
  revision bigint NOT NULL,
  action text NOT NULL CHECK(action IN('created','attended','ended','expired','evidence','approved','invalidated')),
  detail jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(tenant_id,run_id) REFERENCES control_commissioning(tenant_id,id),
  UNIQUE(run_id,revision)
);
CREATE INDEX commissioning_events_history ON commissioning_events(tenant_id,run_id,revision DESC);

-- Existing activation cannot stand in for physical commissioning approval.
INSERT INTO device_control_state(tenant_id,account_id,device,state)
SELECT a.tenant_id,a.id,a.device_sn,'cleanup-required' FROM solarman_accounts a
JOIN controller_state c ON c.tenant_id=a.tenant_id WHERE c.control_enabled AND a.device_sn IS NOT NULL
ON CONFLICT(tenant_id,account_id,device) DO UPDATE SET state='cleanup-required',updated_at=clock_timestamp();
UPDATE device_control_state SET state='cleanup-required',updated_at=clock_timestamp()
WHERE state<>'clear';
UPDATE controller_state SET paused=true,manual_topup=false,topup_expires_at=null,
  control_enabled=false,control_epoch=control_epoch+1,updated_at=clock_timestamp()
WHERE control_enabled OR NOT paused OR manual_topup;
