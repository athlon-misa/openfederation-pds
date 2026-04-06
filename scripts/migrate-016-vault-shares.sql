-- Migration 016: Vault shares for Shamir's Secret Sharing key custody
-- Supports threshold key recovery and progressive sovereignty

CREATE TABLE IF NOT EXISTS vault_shares (
    id VARCHAR(36) PRIMARY KEY,
    user_did VARCHAR(255) NOT NULL,
    share_index INTEGER NOT NULL,
    encrypted_share BYTEA NOT NULL,
    share_holder VARCHAR(32) NOT NULL,
    escrow_provider_did VARCHAR(255),
    recovery_tier INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_did, share_index)
);
CREATE INDEX IF NOT EXISTS idx_vault_shares_did ON vault_shares(user_did);

CREATE TABLE IF NOT EXISTS vault_audit_log (
    id VARCHAR(36) PRIMARY KEY,
    user_did VARCHAR(255) NOT NULL,
    action VARCHAR(64) NOT NULL,
    actor_did VARCHAR(255),
    share_index INTEGER,
    metadata JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_vault_audit_did ON vault_audit_log(user_did);

CREATE TABLE IF NOT EXISTS escrow_providers (
    id VARCHAR(36) PRIMARY KEY,
    did VARCHAR(255) NOT NULL UNIQUE,
    name VARCHAR(255) NOT NULL,
    verification_url VARCHAR(512),
    public_key TEXT,
    status VARCHAR(20) DEFAULT 'active',
    registered_by VARCHAR(255),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
