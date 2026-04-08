-- Migration 020: Custodial secrets table
-- Stores opaque encrypted wallet secrets (e.g. mnemonics) per user per chain.
-- The PDS never decrypts the blob — it is an opaque custodial store.

CREATE TABLE IF NOT EXISTS custodial_secrets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_did TEXT NOT NULL,
  chain TEXT NOT NULL,
  secret_type TEXT NOT NULL,
  encrypted_blob TEXT NOT NULL,
  wallet_address TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_did, chain)
);

CREATE INDEX IF NOT EXISTS custodial_secrets_user_did_idx ON custodial_secrets(user_did);
