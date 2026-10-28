ALTER TABLE solarman_accounts ADD COLUMN monitoring_admitted boolean NOT NULL DEFAULT false;
ALTER TABLE operational_incidents DROP CONSTRAINT operational_incidents_kind_check;
ALTER TABLE operational_incidents ADD CONSTRAINT operational_incidents_kind_check CHECK
  (kind IN ('telemetry_stale','device_offline','request_failures','control_fault','cleanup_pending','api_quota','api_capacity'));
