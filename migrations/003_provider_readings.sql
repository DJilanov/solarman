CREATE TABLE provider_readings (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL,
  account_id uuid NOT NULL,
  device text NOT NULL,
  collected_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  data_list jsonb NOT NULL,
  FOREIGN KEY (tenant_id,account_id) REFERENCES solarman_accounts(tenant_id,id)
);
CREATE INDEX provider_readings_tenant_time ON provider_readings (tenant_id,received_at DESC);
CREATE UNIQUE INDEX provider_readings_latest_device ON provider_readings (tenant_id,account_id,device);
