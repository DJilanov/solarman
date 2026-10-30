CREATE TABLE energy_experience_settings (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id),
  revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
  briefings_enabled boolean NOT NULL DEFAULT false,
  morning_minute integer NOT NULL DEFAULT 435 CHECK(morning_minute BETWEEN 0 AND 1439),
  evening_minute integer NOT NULL DEFAULT 1140 CHECK(evening_minute BETWEEN 0 AND 1439),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE energy_load_tasks (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  account_id uuid NOT NULL,
  device text NOT NULL,
  binding text NOT NULL,
  revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
  name text NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
  power_kw double precision NOT NULL CHECK(power_kw BETWEEN 0.05 AND 50),
  duration_minutes integer NOT NULL CHECK(duration_minutes BETWEEN 15 AND 1440),
  earliest_at timestamptz NOT NULL,
  deadline_at timestamptz NOT NULL CHECK(deadline_at>earliest_at),
  suggested_at timestamptz NOT NULL,
  recommendation jsonb NOT NULL,
  reminder_enabled boolean NOT NULL DEFAULT false,
  reminded_at timestamptz,
  state text NOT NULL DEFAULT 'planned' CHECK(state IN('planned','done','cancelled')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(tenant_id,account_id) REFERENCES solarman_accounts(tenant_id,id)
);
CREATE INDEX energy_load_task_due ON energy_load_tasks(suggested_at) WHERE state='planned' AND reminder_enabled AND reminded_at IS NULL;
CREATE INDEX energy_load_task_tenant ON energy_load_tasks(tenant_id,deadline_at DESC,id);

CREATE TABLE energy_briefing_receipts (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  day date NOT NULL,
  kind text NOT NULL CHECK(kind IN('morning','evening')),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_id,day,kind)
);

ALTER TABLE notification_outbox DROP CONSTRAINT notification_outbox_kind_check;
ALTER TABLE notification_outbox ADD CONSTRAINT notification_outbox_kind_check
  CHECK(kind IN('opened','escalated','resolved','test','platform','energy-briefing','energy-reminder'));
