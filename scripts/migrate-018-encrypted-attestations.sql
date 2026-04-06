-- Migration 018: Encrypted Attestations & Selective Disclosure
-- Adds attestation_encryption and viewing_grants tables for private attestations

CREATE TABLE IF NOT EXISTS attestation_encryption (
    id VARCHAR(36) PRIMARY KEY,
    community_did VARCHAR(255) NOT NULL,
    rkey VARCHAR(255) NOT NULL,
    visibility VARCHAR(10) NOT NULL DEFAULT 'public',
    encrypted_dek_issuer TEXT,
    encrypted_dek_subject TEXT,
    commitment_hash VARCHAR(128),
    issuer_signature TEXT,
    schema_hash VARCHAR(128),
    access_policy JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(community_did, rkey)
);

CREATE TABLE IF NOT EXISTS viewing_grants (
    id VARCHAR(36) PRIMARY KEY,
    attestation_community_did VARCHAR(255) NOT NULL,
    attestation_rkey VARCHAR(255) NOT NULL,
    subject_did VARCHAR(255) NOT NULL,
    granted_to_did VARCHAR(255) NOT NULL,
    expires_at TIMESTAMP NOT NULL,
    granted_fields JSONB,
    status VARCHAR(20) DEFAULT 'active',
    subject_signature TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_viewing_grants_attestation ON viewing_grants(attestation_community_did, attestation_rkey);
CREATE INDEX IF NOT EXISTS idx_viewing_grants_grantee ON viewing_grants(granted_to_did);
