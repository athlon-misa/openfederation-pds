-- scripts/migrate-065-oidc-provider.sql
-- The PDS as an OpenID Connect provider for fediverse apps (ADR-005).
--
-- 1. The provider's RS256 signing key; the private half encrypted with
--    KEY_ENCRYPTION_SECRET (purpose 'oidc.signing-key').
CREATE TABLE IF NOT EXISTS oidc_signing_keys (
    kid VARCHAR(64) PRIMARY KEY,
    public_jwk JSONB NOT NULL,
    encrypted_private_key BYTEA NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Apps registered by an admin. The secret is stored as its SHA-256 (hex).
CREATE TABLE IF NOT EXISTS oidc_clients (
    client_id VARCHAR(64) PRIMARY KEY,
    name TEXT NOT NULL,
    secret_hash CHAR(64) NOT NULL,
    redirect_uris TEXT[] NOT NULL,
    scopes TEXT[] NOT NULL DEFAULT ARRAY['openid', 'profile'],
    community_did TEXT,
    preset VARCHAR(32),
    app_url TEXT,
    created_by VARCHAR(255),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    secret_rotated_at TIMESTAMPTZ
);

-- 3. Sign-ins in progress, from the app's request to the redeemed code.
--    Bound to the starting browser by a cookie whose SHA-256 is browser_hash;
--    the code is single-use (the row is deleted when it is redeemed).
CREATE TABLE IF NOT EXISTS oidc_requests (
    id VARCHAR(64) PRIMARY KEY,
    browser_hash CHAR(64) NOT NULL,
    client_id VARCHAR(64) NOT NULL REFERENCES oidc_clients(client_id) ON DELETE CASCADE,
    redirect_uri TEXT NOT NULL,
    scope TEXT NOT NULL,
    state TEXT,
    nonce TEXT,
    code_challenge TEXT,
    did VARCHAR(255),
    handle TEXT,
    auth_source VARCHAR(16),
    auth_time TIMESTAMPTZ,
    code_hash CHAR(64) UNIQUE,
    code_expires_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_oidc_requests_expires ON oidc_requests(expires_at);
