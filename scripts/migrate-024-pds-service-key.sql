-- Migration 024: PDS service-DID signing key
--
-- The PDS itself publishes a did:web document at /.well-known/did.json
-- (the hostname matching config.pds.hostname). That doc carries a Multikey
-- verificationMethod — this table holds the backing secp256k1 private key,
-- encrypted at rest with KEY_ENCRYPTION_SECRET, same primitive as
-- signing_keys and user_signing_keys.
--
-- Keyed by hostname so a single PDS host cluster can serve multiple
-- service DIDs if ever needed; in practice there's one row per deploy.

CREATE TABLE IF NOT EXISTS pds_service_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    hostname TEXT NOT NULL UNIQUE,
    public_key_multibase TEXT NOT NULL,
    private_key_encrypted BYTEA NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
