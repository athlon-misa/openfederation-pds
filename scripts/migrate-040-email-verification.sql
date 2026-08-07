-- Email verification (#83, part B).
--
-- `users.email_verified_at` records when the user proved ownership of their
-- address; NULL means never. Tokens mirror password_reset_tokens: hashed at
-- rest, single-use, expiring. The token stores the address it was issued
-- for, so an email change between issue and confirm cannot verify the wrong
-- address. No backfill: this deployment has no real users, so everyone
-- verifies (the bootstrap admin is marked verified at startup — the operator
-- configured that address themselves).

ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS email_verification_tokens (
    id VARCHAR(36) PRIMARY KEY,
    user_id VARCHAR(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    email VARCHAR(255) NOT NULL,
    token_hash VARCHAR(255) NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_email_verification_tokens_user ON email_verification_tokens(user_id);
