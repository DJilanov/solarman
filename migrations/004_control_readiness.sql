ALTER TABLE controller_state
  ADD COLUMN control_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN verification jsonb,
  ADD COLUMN topup_expires_at timestamptz;
