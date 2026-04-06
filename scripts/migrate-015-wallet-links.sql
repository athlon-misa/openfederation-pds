-- Migration 015: DID-to-Wallet Linking
-- Adds tables for wallet link challenges and confirmed wallet links.

CREATE TABLE IF NOT EXISTS wallet_links (
    id VARCHAR(36) PRIMARY KEY,
    user_did VARCHAR(255) NOT NULL,
    chain VARCHAR(32) NOT NULL,
    wallet_address VARCHAR(255) NOT NULL,
    label VARCHAR(64),
    challenge TEXT NOT NULL,
    signature TEXT NOT NULL,
    linked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(chain, wallet_address),
    UNIQUE(user_did, label)
);
CREATE INDEX IF NOT EXISTS idx_wallet_links_did ON wallet_links(user_did);
CREATE INDEX IF NOT EXISTS idx_wallet_links_address ON wallet_links(chain, wallet_address);

CREATE TABLE IF NOT EXISTS wallet_link_challenges (
    id VARCHAR(36) PRIMARY KEY,
    user_did VARCHAR(255) NOT NULL,
    chain VARCHAR(32) NOT NULL,
    wallet_address VARCHAR(255) NOT NULL,
    challenge TEXT NOT NULL,
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_wallet_challenges_did ON wallet_link_challenges(user_did);
