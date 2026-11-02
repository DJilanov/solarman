ALTER TABLE energy_plans
  ADD COLUMN start_attempts integer NOT NULL DEFAULT 0 CHECK(start_attempts>=0),
  ADD COLUMN next_start_at timestamptz;
