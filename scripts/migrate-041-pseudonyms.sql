-- scripts/migrate-041-pseudonyms.sql
-- Pseudonyms. Design rule: nothing here may link a pseudonym to its owner,
-- and nothing about token issuance or redemption carries a timestamp.
ALTER TABLE users ALTER COLUMN email DROP NOT NULL;
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS pseudonym_owner_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_pseudonym_owner_key
  ON users(pseudonym_owner_key) WHERE pseudonym_owner_key IS NOT NULL;

-- Migrations run on every boot. Only replace the check when it does not
-- already allow 'pseudonym': dropping and re-adding it takes an ACCESS
-- EXCLUSIVE lock and scans all of users.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'users'::regclass
      AND conname = 'users_auth_type_check'
      AND pg_get_constraintdef(oid) LIKE '%''pseudonym''%'
  ) THEN
    ALTER TABLE users DROP CONSTRAINT IF EXISTS users_auth_type_check;
    ALTER TABLE users ADD CONSTRAINT users_auth_type_check
      CHECK (auth_type IN ('local', 'external', 'pseudonym'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS reserved_signing_keys (
  signing_key TEXT PRIMARY KEY,
  key_bytes BYTEA NOT NULL
);
-- Insertion counter for FIFO eviction (not a timestamp).
ALTER TABLE reserved_signing_keys ADD COLUMN IF NOT EXISTS seq BIGSERIAL;
CREATE INDEX IF NOT EXISTS idx_reserved_signing_keys_seq ON reserved_signing_keys(seq);

CREATE TABLE IF NOT EXISTS pseudonym_login_challenges (
  id UUID PRIMARY KEY,
  owner_key TEXT NOT NULL,
  challenge TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);

-- One blind-signing key per monthly epoch (YYYY-MM, UTC).
CREATE TABLE IF NOT EXISTS pseudonym_token_keys (
  epoch CHAR(7) PRIMARY KEY,
  public_spki BYTEA NOT NULL,
  private_pkcs8 BYTEA NOT NULL
);

-- "This account collected its batch for this epoch". No count, no time.
CREATE TABLE IF NOT EXISTS pseudonym_token_batches (
  user_id VARCHAR(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  epoch CHAR(7) NOT NULL,
  PRIMARY KEY (user_id, epoch)
);

-- Spent tokens, by hash. No time, no account.
CREATE TABLE IF NOT EXISTS pseudonym_tokens_spent (
  epoch CHAR(7) NOT NULL,
  token_hash CHAR(64) NOT NULL,
  PRIMARY KEY (epoch, token_hash)
);
