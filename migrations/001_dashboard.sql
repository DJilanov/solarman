CREATE TABLE tenants (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE users (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  email text NOT NULL,
  password_hash text NOT NULL,
  platform_admin boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,id)
);
CREATE UNIQUE INDEX users_email ON users (lower(email));
CREATE TABLE sessions (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_expiry ON sessions (expires_at);
CREATE TABLE invitations (
  token_hash text PRIMARY KEY,
  email text NOT NULL,
  tenant_name text NOT NULL,
  created_by uuid NOT NULL REFERENCES users(id),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE solarman_accounts (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL UNIQUE REFERENCES tenants(id),
  email text NOT NULL,
  credentials jsonb NOT NULL,
  device_sn text UNIQUE,
  profile text NOT NULL DEFAULT 'monitor-only' CHECK (profile IN ('monitor-only','bluesun-bse20kh3')),
  station_id bigint,
  timezone text NOT NULL DEFAULT 'Europe/Sofia',
  discovered_devices jsonb NOT NULL DEFAULT '[]',
  connection_status text NOT NULL DEFAULT 'pending',
  connection_message text,
  validated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,id)
);
CREATE TABLE measurements (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL,
  account_id uuid NOT NULL,
  device text NOT NULL,
  observed_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  soc integer NOT NULL CHECK (soc BETWEEN 0 AND 100),
  temperature_c double precision NOT NULL,
  pv_w double precision NOT NULL,
  load_w double precision NOT NULL,
  grid_w double precision NOT NULL,
  battery_w double precision NOT NULL,
  ac_enabled boolean NOT NULL,
  snapshot jsonb NOT NULL,
  FOREIGN KEY (tenant_id,account_id) REFERENCES solarman_accounts(tenant_id,id),
  UNIQUE (tenant_id,device,observed_at)
);
CREATE INDEX measurements_tenant_time ON measurements (tenant_id,observed_at DESC);
CREATE TABLE command_executions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  account_id uuid,
  user_id uuid REFERENCES users(id),
  actor text NOT NULL,
  action text NOT NULL,
  idempotency_key uuid,
  status text NOT NULL CHECK (status IN ('queued','running','succeeded','failed','interrupted')),
  message text,
  detail jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  FOREIGN KEY (tenant_id,account_id) REFERENCES solarman_accounts(tenant_id,id),
  FOREIGN KEY (tenant_id,user_id) REFERENCES users(tenant_id,id),
  UNIQUE (tenant_id,user_id,idempotency_key)
);
CREATE INDEX command_executions_tenant_time ON command_executions (tenant_id,created_at DESC);
CREATE TABLE controller_state (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id),
  paused boolean NOT NULL DEFAULT true,
  manual_topup boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
