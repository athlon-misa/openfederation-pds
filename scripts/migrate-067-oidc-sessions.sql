-- scripts/migrate-067-oidc-sessions.sql
-- A remembered sign-in for apps (#462, ADR-005 decision 9 as amended): once
-- someone has signed in to one app through the OpenID Connect provider, the
-- next app in the same browser offers "Continue as …" instead of asking for
-- the account again. The browser holds a random token; only its SHA-256 is
-- stored. Accounts of this server carry users.token_version from the sign-in,
-- so every "end all sessions" event (password change or reset, recovery,
-- sign-out, refresh-token reuse, suspension, takedown) ends it too.
CREATE TABLE IF NOT EXISTS oidc_sessions (
    id_hash CHAR(64) PRIMARY KEY,
    did VARCHAR(255) NOT NULL,
    auth_source VARCHAR(16) NOT NULL,
    token_version INTEGER,
    remote_email TEXT,
    remote_email_verified BOOLEAN NOT NULL DEFAULT FALSE,
    auth_time TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_oidc_sessions_expires ON oidc_sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_oidc_sessions_did ON oidc_sessions(did);

-- Whether the authorization request may be answered by a remembered sign-in:
-- false when the app asked for the account again (prompt=login, max_age).
ALTER TABLE oidc_requests ADD COLUMN IF NOT EXISTS remembered_allowed BOOLEAN NOT NULL DEFAULT FALSE;
