CREATE TABLE command_receipts (
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  idempotency_key uuid NOT NULL,
  action text NOT NULL,
  completed_at timestamptz NOT NULL,
  PRIMARY KEY(tenant_id,user_id,idempotency_key),
  FOREIGN KEY(tenant_id,user_id) REFERENCES users(tenant_id,id) ON DELETE CASCADE
);
