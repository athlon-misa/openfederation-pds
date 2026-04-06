-- Migration 019: Disclosure sessions and audit log
-- Adds tables for time-limited disclosure proxy with watermarking and session-scoped re-encryption.

CREATE TABLE IF NOT EXISTS disclosure_sessions (
    id VARCHAR(36) PRIMARY KEY,
    grant_id VARCHAR(36) NOT NULL REFERENCES viewing_grants(id),
    requester_did VARCHAR(255) NOT NULL,
    session_key_hash VARCHAR(128) NOT NULL,
    watermark_id VARCHAR(36) NOT NULL,
    access_count INTEGER DEFAULT 0,
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_accessed_at TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_disclosure_sessions_grant ON disclosure_sessions(grant_id);

CREATE TABLE IF NOT EXISTS disclosure_audit_log (
    id VARCHAR(36) PRIMARY KEY,
    grant_id VARCHAR(36),
    attestation_community_did VARCHAR(255) NOT NULL,
    attestation_rkey VARCHAR(255) NOT NULL,
    requester_did VARCHAR(255) NOT NULL,
    action VARCHAR(32) NOT NULL,
    watermark_id VARCHAR(36),
    ip_address VARCHAR(45),
    metadata JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_disclosure_audit_attestation ON disclosure_audit_log(attestation_community_did, attestation_rkey);
