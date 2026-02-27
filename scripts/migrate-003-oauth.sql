-- Migration 003: ATProto OAuth Support
-- Adds OAuth authorization server tables and external user support

-- OAuth authorization requests (PAR + authorize flow)
CREATE TABLE IF NOT EXISTS oauth_requests (
    id TEXT PRIMARY KEY,
    data JSONB NOT NULL,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_oauth_requests_expires ON oauth_requests(expires_at);

-- OAuth tokens (DPoP-bound access + refresh)
CREATE TABLE IF NOT EXISTS oauth_tokens (
    id TEXT PRIMARY KEY,
    data JSONB NOT NULL,
    current_refresh_token TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_refresh ON oauth_tokens(current_refresh_token);

-- OAuth used refresh tokens (replay detection)
CREATE TABLE IF NOT EXISTS oauth_used_refresh_tokens (
    token_hash TEXT PRIMARY KEY,
    token_id TEXT NOT NULL REFERENCES oauth_tokens(id) ON DELETE CASCADE,
    used_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- OAuth devices (browser sessions for consent UI)
CREATE TABLE IF NOT EXISTS oauth_devices (
    id TEXT PRIMARY KEY,
    data JSONB NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- OAuth device-account mappings
CREATE TABLE IF NOT EXISTS oauth_device_accounts (
    device_id TEXT NOT NULL REFERENCES oauth_devices(id) ON DELETE CASCADE,
    account_sub TEXT NOT NULL,
    request_id TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (device_id, account_sub)
);
CREATE INDEX IF NOT EXISTS idx_oauth_device_accounts_sub ON oauth_device_accounts(account_sub);
CREATE INDEX IF NOT EXISTS idx_oauth_device_accounts_request ON oauth_device_accounts(request_id);

-- OAuth authorized clients per account
CREATE TABLE IF NOT EXISTS oauth_authorized_clients (
    account_sub TEXT NOT NULL,
    client_id TEXT NOT NULL,
    authorized_scopes JSONB NOT NULL DEFAULT '[]',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (account_sub, client_id)
);

-- External OAuth client state store (for @atproto/oauth-client-node)
CREATE TABLE IF NOT EXISTS external_auth_states (
    key TEXT PRIMARY KEY,
    state JSONB NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- External OAuth client session store
CREATE TABLE IF NOT EXISTS external_auth_sessions (
    key TEXT PRIMARY KEY,
    session JSONB NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Alter users table for external auth support
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS auth_type VARCHAR(10) NOT NULL DEFAULT 'local',
    ADD COLUMN IF NOT EXISTS pds_url TEXT;

-- Make password_hash nullable for external users
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;

-- Add constraint for auth_type (skip if it already exists)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'users_auth_type_check'
    ) THEN
        ALTER TABLE users ADD CONSTRAINT users_auth_type_check
            CHECK (auth_type IN ('local', 'external'));
    END IF;
END $$;
