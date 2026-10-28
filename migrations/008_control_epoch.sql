ALTER TABLE controller_state ADD COLUMN control_epoch bigint NOT NULL DEFAULT 0 CHECK (control_epoch >= 0);
