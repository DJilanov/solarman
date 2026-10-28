CREATE TABLE notification_channels (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL UNIQUE REFERENCES tenants(id),
  kind text NOT NULL DEFAULT 'telegram' CHECK(kind='telegram'),
  chat_id text NOT NULL,
  secret jsonb CHECK(secret IS NULL OR jsonb_typeof(secret)='object'),
  language text NOT NULL CHECK(language IN('en','bg')),
  enabled boolean NOT NULL DEFAULT false,
  quarantined boolean NOT NULL DEFAULT false,
  revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
  verified_at timestamptz,
  last_test_at timestamptz,
  blocked_code text,
  platform_state text,
  platform_sequence bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(tenant_id,id),
  CHECK(NOT enabled OR (NOT quarantined AND verified_at IS NOT NULL AND secret IS NOT NULL))
);
ALTER TABLE operational_incidents ADD CONSTRAINT operational_incident_tenant_id UNIQUE(tenant_id,id);
CREATE TABLE notification_outbox (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  channel_id uuid NOT NULL,
  channel_revision bigint NOT NULL CHECK(channel_revision>0),
  event_key text NOT NULL CHECK(length(event_key) BETWEEN 1 AND 200),
  incident_id uuid,
  kind text NOT NULL CHECK(kind IN('opened','escalated','resolved','test','platform')),
  payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object' AND payload ? 'text' AND payload ? 'title' AND jsonb_typeof(payload->'text')='string' AND length(payload->>'text') BETWEEN 1 AND 4096 AND jsonb_typeof(payload->'title')='string'),
  state text NOT NULL DEFAULT 'queued' CHECK(state IN('queued','sending','retry','delivered','failed','unconfirmed','cancelled')),
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 4),
  had_unconfirmed boolean NOT NULL DEFAULT false,
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  cancel_requested_at timestamptz,
  last_code text,
  message_id bigint,
  UNIQUE(tenant_id,id),
  UNIQUE(channel_id,channel_revision,event_key),
  FOREIGN KEY(tenant_id,channel_id) REFERENCES notification_channels(tenant_id,id),
  FOREIGN KEY(tenant_id,incident_id) REFERENCES operational_incidents(tenant_id,id)
);
CREATE INDEX notification_due ON notification_outbox(next_attempt_at,created_at,id) WHERE state IN('queued','retry');
CREATE INDEX notification_history ON notification_outbox(tenant_id,created_at DESC,id);
CREATE TABLE notification_attempts (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  job_id uuid NOT NULL,
  number integer NOT NULL CHECK(number BETWEEN 1 AND 4),
  state text NOT NULL DEFAULT 'sending' CHECK(state IN('sending','delivered','rejected','unconfirmed','cancelled')),
  code text,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  message_id bigint,
  FOREIGN KEY(tenant_id,job_id) REFERENCES notification_outbox(tenant_id,id),
  UNIQUE(job_id,number)
);
CREATE INDEX notification_attempt_history ON notification_attempts(tenant_id,job_id,number);
CREATE TABLE notification_events (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  channel_id uuid NOT NULL,
  revision bigint NOT NULL,
  actor text NOT NULL,
  action text NOT NULL CHECK(action IN('saved','enabled','disabled','test','closed','restore','blocked')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(tenant_id,channel_id) REFERENCES notification_channels(tenant_id,id)
);
CREATE INDEX notification_event_history ON notification_events(tenant_id,created_at DESC,id);

ALTER TABLE device_health ADD COLUMN auth_fault boolean NOT NULL DEFAULT false;
ALTER TABLE device_health ADD COLUMN auth_fault_at timestamptz;
ALTER TABLE operational_incidents DROP CONSTRAINT operational_incidents_kind_check;
ALTER TABLE operational_incidents ADD CONSTRAINT operational_incidents_kind_check CHECK
  (kind IN('telemetry_stale','device_offline','request_failures','auth_failure','control_fault','cleanup_pending','api_quota','api_capacity'));
