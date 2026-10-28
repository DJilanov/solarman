CREATE TABLE api_app_budgets (
  app_key text PRIMARY KEY CHECK (app_key ~ '^[a-f0-9]{64}$'),
  provider_remaining bigint CHECK (provider_remaining >= 0),
  provider_checked_at timestamptz,
  balance_attempted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE solarman_accounts ADD COLUMN api_app_key text REFERENCES api_app_budgets(app_key);
ALTER TABLE api_requests
  ADD COLUMN app_key text REFERENCES api_app_budgets(app_key),
  ADD COLUMN purpose text NOT NULL DEFAULT 'routine' CHECK (purpose IN ('routine','recovery','balance'));
CREATE INDEX api_requests_app_time ON api_requests (app_key,created_at);
