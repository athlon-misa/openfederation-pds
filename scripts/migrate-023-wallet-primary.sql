-- Migration 023: Primary wallet per chain
--
-- Lets users mark one wallet per chain as primary. Public resolver endpoints
-- (getPrimaryWallet) and the DID document augmentation (W3C verificationMethod
-- entries) default to the primary wallet. Enforced with a partial unique
-- index so only the active, primary wallet per (user, chain) is unique.

ALTER TABLE wallet_links
  ADD COLUMN IF NOT EXISTS is_primary BOOLEAN NOT NULL DEFAULT FALSE;

-- Drop and recreate so re-running the migration is idempotent.
DROP INDEX IF EXISTS idx_wallet_links_primary;
CREATE UNIQUE INDEX idx_wallet_links_primary
  ON wallet_links (user_did, chain)
  WHERE is_primary AND custody_status = 'active';
