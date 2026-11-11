-- scripts/migrate-057-reserved-rotation-keys.sql
-- ADR-003: the rotation key a PDS makes for an `assisted` account before the
-- client builds its genesis operation (account.reserveCustodyKey). Encrypted
-- at rest; no timestamp, capped FIFO by seq like reserved_signing_keys.
CREATE TABLE IF NOT EXISTS reserved_rotation_keys (
  rotation_key TEXT PRIMARY KEY,
  key_bytes BYTEA NOT NULL,
  seq BIGSERIAL
);
CREATE INDEX IF NOT EXISTS idx_reserved_rotation_keys_seq ON reserved_rotation_keys(seq);
