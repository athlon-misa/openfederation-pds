-- Migration 011: Persist ActivityPub RSA signing keys
-- Fixes bug where AP RSA keys were regenerated on every restart, breaking federation
CREATE TABLE IF NOT EXISTS ap_signing_keys (
    did VARCHAR(255) PRIMARY KEY,
    public_key_pem TEXT NOT NULL,
    encrypted_private_key BYTEA NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
