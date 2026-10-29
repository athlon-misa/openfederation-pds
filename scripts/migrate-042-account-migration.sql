-- scripts/migrate-042-account-migration.sql
-- Account migration (#261): an account arriving from another PDS starts
-- deactivated and stays marked until it is activated here.
ALTER TABLE users ADD COLUMN IF NOT EXISTS migrating_in BOOLEAN NOT NULL DEFAULT false;

-- A key reserved for a named DID (com.atproto.server.reserveSigningKey with
-- `did`) is consumed by createAccount for that DID. Reservations without a
-- DID (pseudonym creation) stay anonymous.
ALTER TABLE reserved_signing_keys ADD COLUMN IF NOT EXISTS did TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_reserved_signing_keys_did
  ON reserved_signing_keys(did) WHERE did IS NOT NULL;
