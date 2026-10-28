ALTER TABLE measurements
  ALTER COLUMN ac_enabled DROP NOT NULL,
  ADD COLUMN reading_source text NOT NULL DEFAULT 'register'
    CHECK (reading_source IN ('register','provider')),
  ADD COLUMN sampling_seconds integer NOT NULL DEFAULT 900
    CHECK (sampling_seconds BETWEEN 30 AND 1800);
