-- Migration 021: Progressive-custody wallet tiers
--
-- Adds tier metadata to wallet_links and introduces:
--   * wallet_custody — Tier 1 (PDS-custodial) private keys, encrypted at rest
--     with KEY_ENCRYPTION_SECRET (same AES-256-GCM primitive as signing_keys).
--   * wallet_dapp_consents — OAuth-style per-dApp-origin grants that authorize
--     the PDS to sign with a Tier 1 wallet on behalf of the user.
--
-- Tier semantics:
--   custodial       — PDS holds decryptable key (Tier 1)
--   user_encrypted  — PDS holds passphrase-wrapped blob in custodial_secrets (Tier 2)
--   self_custody    — PDS holds only the public link (Tier 3)
--
-- The default for existing rows is 'self_custody' because today's linkWallet
-- flow is BYOW — the PDS has never held decryptable material for them.

ALTER TABLE wallet_links
  ADD COLUMN IF NOT EXISTS custody_tier TEXT NOT NULL DEFAULT 'self_custody';

ALTER TABLE wallet_links
  ADD COLUMN IF NOT EXISTS custody_status TEXT NOT NULL DEFAULT 'active';

-- Drop any previous (idempotency-friendly) CHECK so re-running the migration
-- doesn't fail if the names are already taken.
ALTER TABLE wallet_links DROP CONSTRAINT IF EXISTS wallet_links_custody_tier_chk;
ALTER TABLE wallet_links DROP CONSTRAINT IF EXISTS wallet_links_custody_status_chk;

ALTER TABLE wallet_links
  ADD CONSTRAINT wallet_links_custody_tier_chk
  CHECK (custody_tier IN ('custodial', 'user_encrypted', 'self_custody'));

ALTER TABLE wallet_links
  ADD CONSTRAINT wallet_links_custody_status_chk
  CHECK (custody_status IN ('active', 'exported', 'superseded'));

CREATE INDEX IF NOT EXISTS idx_wallet_links_tier ON wallet_links(user_did, custody_tier);


-- Tier 1 custody — the PDS stores the private key bytes encrypted at rest.
-- Decryption happens only in-memory during a single sign() request, then wiped.
CREATE TABLE IF NOT EXISTS wallet_custody (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_did VARCHAR(255) NOT NULL,
    chain VARCHAR(32) NOT NULL,
    wallet_address VARCHAR(255) NOT NULL,
    private_key_encrypted BYTEA NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(user_did, chain, wallet_address),
    FOREIGN KEY (user_did) REFERENCES users(did) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_wallet_custody_user_did ON wallet_custody(user_did);


-- Per-dApp consent grants for Tier 1 signing. Each grant scopes what dApp
-- origin can request signatures, optionally for a specific wallet, with an
-- expiry after which the user must re-consent.
CREATE TABLE IF NOT EXISTS wallet_dapp_consents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_did VARCHAR(255) NOT NULL,
    dapp_origin TEXT NOT NULL,
    -- Scope can be all Tier 1 wallets (chain + wallet_address NULL) or a
    -- single wallet. Finer scopes are preferred; we default to single-wallet
    -- grants from the SDK.
    chain VARCHAR(32),
    wallet_address VARCHAR(255),
    granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    FOREIGN KEY (user_did) REFERENCES users(did) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_wallet_consents_lookup
  ON wallet_dapp_consents(user_did, dapp_origin)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_wallet_consents_expiry
  ON wallet_dapp_consents(expires_at)
  WHERE revoked_at IS NULL;
