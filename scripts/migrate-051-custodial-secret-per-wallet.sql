-- scripts/migrate-051-custodial-secret-per-wallet.sql
-- A wrapped wallet secret belongs to one wallet. The table allowed one row per
-- (user, chain), while an account may hold several wallets on a chain, so
-- storing the secret of a second wallet silently replaced the first wallet's
-- and left it with no key anywhere. One row per (user, chain, wallet).
ALTER TABLE custodial_secrets DROP CONSTRAINT IF EXISTS custodial_secrets_user_did_chain_key;
CREATE UNIQUE INDEX IF NOT EXISTS custodial_secrets_user_chain_wallet_key
  ON custodial_secrets (user_did, chain, wallet_address);
