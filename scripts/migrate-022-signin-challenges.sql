-- Migration 022: Sign-In With OpenFederation (SIWOF)
--
-- Extends wallet_link_challenges with a purpose discriminator so the table can
-- serve both the existing BYOW wallet-link proof and the new sign-in flow.
-- `audience` is the dApp origin the challenge is scoped to (NULL for link).

ALTER TABLE wallet_link_challenges
  ADD COLUMN IF NOT EXISTS purpose TEXT NOT NULL DEFAULT 'link';

ALTER TABLE wallet_link_challenges
  ADD COLUMN IF NOT EXISTS audience TEXT;

ALTER TABLE wallet_link_challenges DROP CONSTRAINT IF EXISTS wallet_link_challenges_purpose_chk;
ALTER TABLE wallet_link_challenges
  ADD CONSTRAINT wallet_link_challenges_purpose_chk
  CHECK (purpose IN ('link', 'signin'));

CREATE INDEX IF NOT EXISTS idx_wallet_challenges_purpose
  ON wallet_link_challenges(user_did, purpose, expires_at);
