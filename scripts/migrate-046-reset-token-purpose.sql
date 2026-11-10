-- scripts/migrate-046-reset-token-purpose.sql
-- password_reset_tokens also holds admin identity-verification codes. Without a
-- purpose, a verification code (which the user is asked to read aloud to an
-- administrator) was redeemable as a password-reset token. Each row now says
-- what it may be used for, and each consumer only accepts its own kind.
ALTER TABLE password_reset_tokens
  ADD COLUMN IF NOT EXISTS purpose VARCHAR(32) NOT NULL DEFAULT 'password-reset';
