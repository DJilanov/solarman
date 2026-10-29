ALTER TABLE notification_channels DROP CONSTRAINT notification_channels_tenant_id_key;
ALTER TABLE notification_channels DROP CONSTRAINT notification_channels_kind_check;
ALTER TABLE notification_channels ADD CONSTRAINT notification_channels_kind_check CHECK(kind IN('telegram','webpush'));
CREATE UNIQUE INDEX notification_telegram_tenant ON notification_channels(tenant_id) WHERE kind='telegram';
ALTER TABLE notification_channels
  ADD COLUMN user_id uuid,
  ADD COLUMN endpoint_hash text UNIQUE CHECK(endpoint_hash IS NULL OR endpoint_hash ~ '^[a-f0-9]{64}$'),
  ADD COLUMN push_enable_pending boolean NOT NULL DEFAULT false,
  ADD COLUMN push_request_id uuid,
  ADD COLUMN push_request_hash text CHECK(push_request_hash IS NULL OR push_request_hash ~ '^[a-f0-9]{64}$'),
  ADD COLUMN revoked_at timestamptz,
  ADD FOREIGN KEY(tenant_id,user_id) REFERENCES users(tenant_id,id),
  ADD CHECK(kind<>'webpush' OR (user_id IS NOT NULL AND endpoint_hash IS NOT NULL)),
  ADD CHECK(NOT push_enable_pending OR (kind='webpush' AND NOT quarantined AND secret IS NOT NULL AND revoked_at IS NULL));
CREATE INDEX notification_push_devices ON notification_channels(tenant_id,user_id,created_at DESC) WHERE kind='webpush' AND revoked_at IS NULL;
ALTER TABLE notification_attempts ADD COLUMN push_receipt_hash text CHECK(push_receipt_hash IS NULL OR push_receipt_hash ~ '^[a-f0-9]{64}$');
ALTER TABLE notification_attempts ADD COLUMN push_displayed_at timestamptz;
ALTER TABLE notification_outbox ADD COLUMN push_displayed_at timestamptz;
ALTER TABLE notification_events DROP CONSTRAINT notification_events_action_check;
ALTER TABLE notification_events ADD CONSTRAINT notification_events_action_check CHECK(action IN('saved','enabled','disabled','test','closed','restore','blocked','rollback'));
