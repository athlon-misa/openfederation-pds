-- Migration 004: Partner API keys
-- Allows trusted partners (e.g. game platforms) to register users directly

CREATE TABLE IF NOT EXISTS partner_keys (
    id VARCHAR(36) PRIMARY KEY,
    key_hash VARCHAR(128) NOT NULL UNIQUE,
    key_prefix VARCHAR(12) NOT NULL,
    name VARCHAR(255) NOT NULL,
    partner_name VARCHAR(255) NOT NULL,
    created_by VARCHAR(36) REFERENCES users(id),
    permissions JSONB NOT NULL DEFAULT '["register"]',
    allowed_origins JSONB DEFAULT NULL,
    rate_limit_per_hour INTEGER NOT NULL DEFAULT 100,
    status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
    revoked_at TIMESTAMPTZ,
    revoked_by VARCHAR(36) REFERENCES users(id),
    last_used_at TIMESTAMPTZ,
    total_registrations INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_partner_keys_status ON partner_keys(status);
CREATE INDEX IF NOT EXISTS idx_partner_keys_hash ON partner_keys(key_hash);

ALTER TABLE users ADD COLUMN IF NOT EXISTS created_by_partner VARCHAR(36) REFERENCES partner_keys(id);
