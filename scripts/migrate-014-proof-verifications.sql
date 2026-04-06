-- Migration 014: Proof verifications for chain-specific governance proof verification
CREATE TABLE IF NOT EXISTS proof_verifications (
    id VARCHAR(36) PRIMARY KEY,
    community_did VARCHAR(255) NOT NULL,
    chain_id VARCHAR(64) NOT NULL,
    transaction_hash VARCHAR(255) NOT NULL,
    block_number INTEGER,
    contract_address VARCHAR(255),
    verified BOOLEAN NOT NULL,
    error TEXT,
    block_timestamp BIGINT,
    confirmations INTEGER,
    oracle_credential_id VARCHAR(36) REFERENCES oracle_credentials(id),
    verified_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(chain_id, transaction_hash)
);
CREATE INDEX IF NOT EXISTS idx_proof_verifications_community ON proof_verifications(community_did);
CREATE INDEX IF NOT EXISTS idx_proof_verifications_chain_tx ON proof_verifications(chain_id, transaction_hash);
