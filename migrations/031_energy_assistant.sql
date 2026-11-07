ALTER TABLE energy_experience_settings
  ADD COLUMN insights_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN auto_replan boolean NOT NULL DEFAULT false,
  ADD COLUMN load_revision bigint NOT NULL DEFAULT 0 CHECK(load_revision>=0),
  ADD COLUMN away_revision bigint NOT NULL DEFAULT 0 CHECK(away_revision>=0),
  ADD COLUMN last_replan_at timestamptz,
  ADD COLUMN replan_code text,
  ADD COLUMN replan_forecast_at timestamptz,
  ADD COLUMN insights_checked_at timestamptz,
  ADD COLUMN insights_assessment jsonb;

ALTER TABLE energy_load_tasks ADD COLUMN schedule_code text;

CREATE TABLE energy_away_periods (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  account_id uuid NOT NULL,
  device text NOT NULL,
  binding text NOT NULL,
  starts_at timestamptz NOT NULL,
  returns_at timestamptz NOT NULL CHECK(returns_at>starts_at),
  baseline_w double precision NOT NULL CHECK(baseline_w BETWEEN 50 AND 20000),
  normal_model jsonb CHECK(normal_model IS NULL OR jsonb_typeof(normal_model)='object'),
  state text NOT NULL DEFAULT 'planned' CHECK(state IN('planned','cancelled','quarantined')),
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(tenant_id,account_id) REFERENCES solarman_accounts(tenant_id,id)
);
CREATE INDEX energy_away_period_tenant ON energy_away_periods(tenant_id,starts_at,id);

CREATE TABLE energy_insights (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  account_id uuid NOT NULL,
  device text NOT NULL,
  binding text NOT NULL,
  kind text NOT NULL CHECK(kind IN('consumption-high','solar-low')),
  evidence jsonb NOT NULL CHECK(jsonb_typeof(evidence)='object'),
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  resolved_at timestamptz,
  resolution_reason text CHECK(resolution_reason IN('cleared','binding-changed','quarantined')),
  seen_at timestamptz,
  snoozed_until timestamptz,
  notified_at timestamptz,
  FOREIGN KEY(tenant_id,account_id) REFERENCES solarman_accounts(tenant_id,id)
);
CREATE UNIQUE INDEX energy_insight_open ON energy_insights(tenant_id,binding,kind) WHERE resolved_at IS NULL;
CREATE INDEX energy_insight_history ON energy_insights(tenant_id,first_seen_at DESC,id);

CREATE TABLE energy_outage_watches (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL UNIQUE REFERENCES tenants(id),
  account_id uuid NOT NULL,
  device text NOT NULL,
  provider text NOT NULL DEFAULT 'erm-zapad' CHECK(provider='erm-zapad'),
  reference_kind text NOT NULL CHECK(reference_kind IN('supply-point','area')),
  reference_hint text NOT NULL CHECK(length(reference_hint)<=80),
  secret jsonb CHECK(secret IS NULL OR jsonb_typeof(secret)='object'),
  enabled boolean NOT NULL DEFAULT false,
  quarantined boolean NOT NULL DEFAULT false,
  revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
  checked_at timestamptz,
  attempted_at timestamptz,
  last_code text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(tenant_id,account_id) REFERENCES solarman_accounts(tenant_id,id),
  UNIQUE(tenant_id,id),
  CHECK(NOT enabled OR (secret IS NOT NULL AND NOT quarantined))
);
CREATE TABLE energy_outage_notices (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  watch_id uuid NOT NULL,
  source_key text NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL CHECK(ends_at>starts_at),
  detail text NOT NULL CHECK(length(detail) BETWEEN 1 AND 4000),
  scope text NOT NULL CHECK(scope IN('supply-point','area')),
  source_url text NOT NULL,
  fetched_at timestamptz NOT NULL,
  withdrawn_at timestamptz,
  seen_at timestamptz,
  notified_at timestamptz,
  UNIQUE(watch_id,source_key),
  FOREIGN KEY(tenant_id,watch_id) REFERENCES energy_outage_watches(tenant_id,id)
);
CREATE INDEX energy_outage_notice_tenant ON energy_outage_notices(tenant_id,starts_at,id);

CREATE TABLE energy_utility_requests (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX energy_utility_request_time ON energy_utility_requests(created_at);
CREATE TABLE energy_utility_publications (
  source_id text PRIMARY KEY,
  day date NOT NULL,
  fetched_at timestamptz NOT NULL,
  notices jsonb NOT NULL CHECK(jsonb_typeof(notices)='array')
);

ALTER TABLE notification_outbox DROP CONSTRAINT notification_outbox_kind_check;
ALTER TABLE notification_outbox ADD CONSTRAINT notification_outbox_kind_check
  CHECK(kind IN('opened','escalated','resolved','test','platform','energy-briefing','energy-reminder','energy-insight','outage-notice'));
