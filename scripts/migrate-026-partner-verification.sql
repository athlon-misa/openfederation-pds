-- Migration 026: partner-key domain-ownership verification
--
-- Partner keys bypass the invite gate and auto-approve users, so the
-- declared `allowed_origins` must represent domains the partner actually
-- controls. This migration adds a two-step verification handshake:
--
--   1. Admin creates a key — row starts with verification_state='pending'
--      and a hashed verification_token. The raw token + instructions are
--      returned to the caller once (never stored plaintext).
--   2. Partner publishes {"token":"<raw>"} at
--      /.well-known/openfederation-partner.json on each allowed_origin.
--   3. Admin calls partner.verifyKey, which fetches each origin, checks
--      the token matches, and flips verification_state to 'verified'.
--
-- Pending keys are rejected by validatePartnerKey. Existing rows default
-- to 'verified' so grandfathered keys keep working.

ALTER TABLE partner_keys
  ADD COLUMN IF NOT EXISTS verification_state TEXT NOT NULL DEFAULT 'verified'
    CHECK (verification_state IN ('pending', 'verified'));

ALTER TABLE partner_keys
  ADD COLUMN IF NOT EXISTS verification_token_hash TEXT;

ALTER TABLE partner_keys
  ADD COLUMN IF NOT EXISTS verified_at TIMESTAMP WITH TIME ZONE;

CREATE INDEX IF NOT EXISTS idx_partner_keys_verification_state
  ON partner_keys(verification_state);
