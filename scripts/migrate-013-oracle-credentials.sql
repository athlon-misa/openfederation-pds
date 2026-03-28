-- Migration 013: Oracle credentials for on-chain governance
CREATE TABLE IF NOT EXISTS oracle_credentials (
    id VARCHAR(36) PRIMARY KEY,
    community_did VARCHAR(255) NOT NULL,
    key_prefix VARCHAR(16) NOT NULL,
    key_hash VARCHAR(255) NOT NULL,
    name VARCHAR(255) NOT NULL,
    created_by VARCHAR(36) REFERENCES users(id) ON DELETE SET NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
    allowed_origins JSONB,
    revoked_at TIMESTAMP WITH TIME ZONE,
    last_used_at TIMESTAMP WITH TIME ZONE,
    proofs_submitted INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_oracle_credentials_hash ON oracle_credentials(key_hash);
CREATE INDEX IF NOT EXISTS idx_oracle_credentials_community ON oracle_credentials(community_did);
