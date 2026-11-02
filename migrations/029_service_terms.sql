ALTER TABLE users ADD COLUMN service_terms_version text;
ALTER TABLE users ADD COLUMN service_terms_accepted_at timestamptz;
ALTER TABLE users ADD CONSTRAINT users_service_terms_check CHECK
  ((service_terms_version IS NULL AND service_terms_accepted_at IS NULL) OR
   (service_terms_version IS NOT NULL AND service_terms_version ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' AND service_terms_accepted_at IS NOT NULL));
