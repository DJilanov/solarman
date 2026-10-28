CREATE UNIQUE INDEX command_executions_tenant_id ON command_executions (tenant_id,id);
CREATE TABLE device_control_state (
  tenant_id uuid NOT NULL,
  account_id uuid NOT NULL,
  device text NOT NULL,
  state text NOT NULL CHECK (state IN ('clear','owned','uncertain','cleanup-required')),
  confirmed_off_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,account_id,device),
  FOREIGN KEY (tenant_id,account_id) REFERENCES solarman_accounts(tenant_id,id)
);
CREATE TABLE inverter_write_intents (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  account_id uuid NOT NULL,
  device text NOT NULL,
  execution_id uuid,
  operation text NOT NULL CHECK (operation IN ('enable','disable','window')),
  address integer NOT NULL CHECK (address IN (206,2509)),
  register_values jsonb NOT NULL CHECK (jsonb_typeof(register_values)='array'),
  status text NOT NULL DEFAULT 'prepared' CHECK (status IN ('prepared','acknowledged','verified','uncertain')),
  created_at timestamptz NOT NULL DEFAULT now(),
  acknowledged_at timestamptz,
  verified_at timestamptz,
  reconciled_at timestamptz,
  FOREIGN KEY (tenant_id,account_id,device) REFERENCES device_control_state(tenant_id,account_id,device),
  FOREIGN KEY (tenant_id,execution_id) REFERENCES command_executions(tenant_id,id)
);
CREATE INDEX inverter_write_intents_binding_time ON inverter_write_intents (tenant_id,account_id,device,created_at DESC);
INSERT INTO device_control_state (tenant_id,account_id,device,state)
SELECT a.tenant_id,a.id,a.device_sn,'cleanup-required' FROM solarman_accounts a
JOIN controller_state c ON c.tenant_id=a.tenant_id
WHERE c.control_enabled AND a.device_sn IS NOT NULL;
