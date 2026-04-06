-- Migration 017: Identity Recovery Tiers
-- Adds recovery tier tracking and recovery attempt history

-- Add recovery columns to users table
ALTER TABLE users ADD COLUMN IF NOT EXISTS recovery_tier INTEGER DEFAULT 1;
ALTER TABLE users ADD COLUMN IF NOT EXISTS recovery_email_verified BOOLEAN DEFAULT false;

-- Recovery attempts table: tracks all recovery operations
CREATE TABLE IF NOT EXISTS recovery_attempts (
    id VARCHAR(36) PRIMARY KEY,
    user_did VARCHAR(255) NOT NULL,
    tier INTEGER NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'expired', 'failed')),
    token_hash VARCHAR(255),
    expires_at TIMESTAMP WITH TIME ZONE,
    initiated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP WITH TIME ZONE,
    initiated_by VARCHAR(255),
    ip_address VARCHAR(45),
    metadata JSONB
);
CREATE INDEX IF NOT EXISTS idx_recovery_attempts_did ON recovery_attempts(user_did);
CREATE INDEX IF NOT EXISTS idx_recovery_attempts_token ON recovery_attempts(token_hash);
CREATE INDEX IF NOT EXISTS idx_recovery_attempts_status ON recovery_attempts(user_did, status);
