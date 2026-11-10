-- scripts/migrate-053-wallet-consent-approval.sql
-- A custodial signing consent is approved by the user on a page this PDS
-- serves (wallet_consent_requests), never granted by the dApp's own script,
-- and it states its limits: contracts it covers and how much value it may
-- move. Consents granted the old way carry no contracts, so they keep
-- working for message signing and sign no transactions.
ALTER TABLE wallet_dapp_consents ADD COLUMN IF NOT EXISTS allowed_contracts JSONB;
ALTER TABLE wallet_dapp_consents ADD COLUMN IF NOT EXISTS max_value_per_tx NUMERIC(78, 0);
ALTER TABLE wallet_dapp_consents ADD COLUMN IF NOT EXISTS max_total_value NUMERIC(78, 0);
ALTER TABLE wallet_dapp_consents ADD COLUMN IF NOT EXISTS spent_value NUMERIC(78, 0) NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS wallet_consent_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_did VARCHAR(255) NOT NULL REFERENCES users(did) ON DELETE CASCADE,
    dapp_origin TEXT NOT NULL,
    chain VARCHAR(32),
    wallet_address VARCHAR(255),
    allowed_contracts JSONB,
    max_value_per_tx NUMERIC(78, 0),
    max_total_value NUMERIC(78, 0),
    ttl_seconds INTEGER NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied')),
    consent_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wallet_consent_requests_user ON wallet_consent_requests(user_did, created_at);
