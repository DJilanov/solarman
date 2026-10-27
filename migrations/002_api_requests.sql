CREATE TABLE api_requests (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  account_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('token','command','read')),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,account_id) REFERENCES solarman_accounts(tenant_id,id)
);
CREATE INDEX api_requests_tenant_time ON api_requests (tenant_id,created_at);
