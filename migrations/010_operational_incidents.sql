CREATE TABLE device_health (
  tenant_id uuid NOT NULL,
  account_id uuid NOT NULL,
  device text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  attempted_at timestamptz,
  succeeded_at timestamptz,
  failed_at timestamptz,
  uploaded_at timestamptz,
  reported_at timestamptz,
  device_state integer CHECK (device_state IN (1,2,3)),
  failures integer NOT NULL DEFAULT 0 CHECK (failures >= 0),
  control_fault boolean NOT NULL DEFAULT false,
  control_fault_at timestamptz,
  PRIMARY KEY (tenant_id,account_id,device),
  FOREIGN KEY (tenant_id,account_id) REFERENCES solarman_accounts(tenant_id,id)
);
INSERT INTO device_health (tenant_id,account_id,device,succeeded_at,uploaded_at)
SELECT a.tenant_id,a.id,a.device_sn,p.received_at,p.collected_at FROM solarman_accounts a
LEFT JOIN provider_readings p ON p.tenant_id=a.tenant_id AND p.account_id=a.id AND p.device=a.device_sn
WHERE a.device_sn IS NOT NULL;
CREATE TABLE operational_incidents (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  account_id uuid NOT NULL,
  device text NOT NULL,
  binding text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('telemetry_stale','device_offline','request_failures','control_fault','cleanup_pending','api_quota')),
  severity text NOT NULL CHECK (severity IN ('warning','critical')),
  detail_code text CHECK (detail_code IN ('low','recovery-only','exhausted')),
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolution_reason text CHECK (resolution_reason IN ('cleared','binding_changed')),
  acknowledged_at timestamptz,
  acknowledged_by uuid,
  revision integer NOT NULL DEFAULT 1,
  FOREIGN KEY (tenant_id,account_id) REFERENCES solarman_accounts(tenant_id,id),
  FOREIGN KEY (tenant_id,acknowledged_by) REFERENCES users(tenant_id,id)
);
CREATE UNIQUE INDEX operational_incidents_open ON operational_incidents (tenant_id,binding,kind) WHERE resolved_at IS NULL;
CREATE INDEX operational_incidents_tenant_time ON operational_incidents (tenant_id,last_seen_at DESC,id DESC);
