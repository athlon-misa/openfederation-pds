-- OpenFederation PDS Database Schema
-- Version: 1.0
-- Date: 2026-02-05

-- Users table: stores account information for auth
CREATE TABLE IF NOT EXISTS users (
    id VARCHAR(36) PRIMARY KEY,
    handle VARCHAR(255) UNIQUE NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    status VARCHAR(20) NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'disabled', 'suspended', 'takendown', 'deactivated')),
    did VARCHAR(255) UNIQUE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    approved_at TIMESTAMP WITH TIME ZONE,
    approved_by VARCHAR(36) REFERENCES users(id) ON DELETE SET NULL,
    created_by_partner VARCHAR(36),
    status_changed_at TIMESTAMP WITH TIME ZONE,
    status_changed_by VARCHAR(36) REFERENCES users(id) ON DELETE SET NULL,
    status_reason TEXT,
    exported_at TIMESTAMP WITH TIME ZONE,
    failed_login_attempts INTEGER NOT NULL DEFAULT 0,
    locked_until TIMESTAMP WITH TIME ZONE,
    recovery_tier INTEGER DEFAULT 1,
    recovery_email_verified BOOLEAN DEFAULT false
    -- FK to partner_keys(id) added after partner_keys table creation
);

CREATE INDEX idx_users_status ON users(status);

-- User roles table: admin/moderator/user roles
CREATE TABLE IF NOT EXISTS user_roles (
    user_id VARCHAR(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role VARCHAR(20) NOT NULL CHECK (role IN ('admin', 'moderator', 'partner-manager', 'auditor', 'user')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, role)
);

CREATE INDEX idx_user_roles_role ON user_roles(role);

-- Invite codes table: invite-only registration
CREATE TABLE IF NOT EXISTS invites (
    code VARCHAR(64) PRIMARY KEY,
    created_by VARCHAR(36) REFERENCES users(id) ON DELETE SET NULL,
    used_by VARCHAR(36) REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    used_at TIMESTAMP WITH TIME ZONE,
    expires_at TIMESTAMP WITH TIME ZONE,
    max_uses INTEGER NOT NULL DEFAULT 1,
    uses_count INTEGER NOT NULL DEFAULT 0,
    bound_to VARCHAR(255),
    note TEXT
);

CREATE INDEX idx_invites_expires_at ON invites(expires_at);

-- Sessions table: refresh token storage
CREATE TABLE IF NOT EXISTS sessions (
    id VARCHAR(36) PRIMARY KEY,
    user_id VARCHAR(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    refresh_token_hash VARCHAR(255) NOT NULL,
    previous_token_hash VARCHAR(255),  -- for token reuse detection
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    last_used_at TIMESTAMP WITH TIME ZONE,
    revoked_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expires_at ON sessions(expires_at);
CREATE INDEX idx_sessions_previous_hash ON sessions(previous_token_hash);

-- Communities table: stores basic community information
CREATE TABLE IF NOT EXISTS communities (
    did VARCHAR(255) PRIMARY KEY,
    handle VARCHAR(255) UNIQUE NOT NULL,
    did_method VARCHAR(10) NOT NULL CHECK (did_method IN ('plc', 'web')),
    created_by VARCHAR(36) REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'takendown')),
    status_changed_at TIMESTAMP WITH TIME ZONE,
    status_changed_by VARCHAR(36) REFERENCES users(id) ON DELETE SET NULL,
    status_reason TEXT,
    exported_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX idx_communities_handle ON communities(handle);
CREATE INDEX idx_communities_status ON communities(status);

-- PLC Keys table: stores encrypted recovery keys for did:plc communities
-- IMPORTANT: The recovery_key_bytes should be encrypted at rest
CREATE TABLE IF NOT EXISTS plc_keys (
    community_did VARCHAR(255) PRIMARY KEY REFERENCES communities(did) ON DELETE CASCADE,
    recovery_key_bytes BYTEA NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Repository Blocks table: stores raw blocks (authoritative storage)
-- This is the source of truth for all repository data.
-- No FK to communities — blocks can belong to both community and user repos.
CREATE TABLE IF NOT EXISTS repo_blocks (
    community_did VARCHAR(255) NOT NULL,
    cid VARCHAR(255) NOT NULL,
    block_bytes BYTEA NOT NULL,
    rev TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (community_did, cid)
);

CREATE INDEX idx_repo_blocks_community ON repo_blocks(community_did);
CREATE INDEX IF NOT EXISTS idx_repo_blocks_rev ON repo_blocks(community_did, rev);

-- Repo roots table: tracks root CID and current revision per DID
CREATE TABLE IF NOT EXISTS repo_roots (
    did TEXT PRIMARY KEY,
    root_cid TEXT NOT NULL,
    rev TEXT NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Records Index table: provides fast lookup of current records
-- This is a convenience index; repo_blocks is authoritative.
-- No FK to communities — records can belong to both community and user repos.
CREATE TABLE IF NOT EXISTS records_index (
    id SERIAL PRIMARY KEY,
    community_did VARCHAR(255) NOT NULL,
    collection VARCHAR(255) NOT NULL,
    rkey VARCHAR(255) NOT NULL,
    cid VARCHAR(255) NOT NULL,
    record JSONB NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(community_did, collection, rkey)
);

CREATE INDEX idx_records_community_collection ON records_index(community_did, collection);
CREATE INDEX idx_records_cid ON records_index(cid);

-- Members Unique table: enforces one membership per DID per community
-- This prevents duplicate memberships as per the schema fix in documentation
CREATE TABLE IF NOT EXISTS members_unique (
    community_did VARCHAR(255) NOT NULL REFERENCES communities(did) ON DELETE CASCADE,
    member_did VARCHAR(255) NOT NULL,
    record_rkey VARCHAR(255) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(community_did, member_did),
    PRIMARY KEY(community_did, member_did)
);

CREATE INDEX idx_members_community ON members_unique(community_did);
CREATE INDEX idx_members_did ON members_unique(member_did);

-- Commits table: stores the commit history for each repository
CREATE TABLE IF NOT EXISTS commits (
    id SERIAL PRIMARY KEY,
    community_did VARCHAR(255) NOT NULL REFERENCES communities(did) ON DELETE CASCADE,
    cid VARCHAR(255) NOT NULL,
    prev_cid VARCHAR(255),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_commits_community ON commits(community_did);
CREATE INDEX idx_commits_cid ON commits(cid);

-- Join Requests table: tracks requests to join communities with approval-required join policy
CREATE TABLE IF NOT EXISTS join_requests (
    id VARCHAR(36) PRIMARY KEY,
    community_did VARCHAR(255) NOT NULL REFERENCES communities(did) ON DELETE CASCADE,
    user_id VARCHAR(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user_did VARCHAR(255) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    resolved_by VARCHAR(36) REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    resolved_at TIMESTAMP WITH TIME ZONE,
    UNIQUE(community_did, user_id)
);

CREATE INDEX idx_join_requests_community ON join_requests(community_did);
CREATE INDEX idx_join_requests_status ON join_requests(community_did, status);

-- Signing keys table: stores encrypted signing keys for community repos
CREATE TABLE IF NOT EXISTS signing_keys (
    community_did VARCHAR(255) PRIMARY KEY REFERENCES communities(did) ON DELETE CASCADE,
    signing_key_bytes BYTEA NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- User signing keys table: stores encrypted signing keys for user repos
-- Separate from signing_keys (which FKs to communities.did)
CREATE TABLE IF NOT EXISTS user_signing_keys (
    user_did TEXT PRIMARY KEY,
    signing_key_bytes BYTEA NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Audit log table: tracks admin and security-relevant actions
CREATE TABLE IF NOT EXISTS audit_log (
    id SERIAL PRIMARY KEY,
    action VARCHAR(64) NOT NULL,
    actor_id VARCHAR(36),
    target_id VARCHAR(255),
    meta JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_audit_log_action ON audit_log(action);
CREATE INDEX idx_audit_log_actor ON audit_log(actor_id);
CREATE INDEX idx_audit_log_created ON audit_log(created_at);

-- Partner API keys: allows trusted partners to register users directly
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

CREATE INDEX idx_partner_keys_status ON partner_keys(status);
CREATE INDEX idx_partner_keys_hash ON partner_keys(key_hash);

-- Blob storage metadata
CREATE TABLE IF NOT EXISTS blobs (
    cid TEXT PRIMARY KEY,
    did TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_blobs_did ON blobs(did);

-- Export schedules for automated community backups
CREATE TABLE IF NOT EXISTS export_schedules (
    id VARCHAR(36) PRIMARY KEY,
    community_did TEXT NOT NULL,
    interval TEXT NOT NULL CHECK (interval IN ('daily', 'weekly', 'monthly')),
    retention_count INTEGER NOT NULL DEFAULT 5,
    enabled BOOLEAN NOT NULL DEFAULT true,
    last_export_at TIMESTAMP WITH TIME ZONE,
    last_status TEXT,
    last_error TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(community_did)
);

-- Export snapshot metadata
CREATE TABLE IF NOT EXISTS export_snapshots (
    id VARCHAR(36) PRIMARY KEY,
    community_did TEXT NOT NULL,
    storage_key TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    root_cid TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_export_snapshots_did ON export_snapshots(community_did);

-- Password reset tokens: self-service password reset via email
CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id VARCHAR(36) PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id VARCHAR(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash VARCHAR(255) NOT NULL,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    used_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_hash ON password_reset_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user ON password_reset_tokens(user_id);

-- ActivityPub RSA signing keys: persisted per-community DID to survive restarts
CREATE TABLE IF NOT EXISTS ap_signing_keys (
    did VARCHAR(255) PRIMARY KEY,
    public_key_pem TEXT NOT NULL,
    encrypted_private_key BYTEA NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Oracle credentials: API keys for on-chain governance proof submission
CREATE TABLE IF NOT EXISTS oracle_credentials (
    id VARCHAR(36) PRIMARY KEY,
    community_did VARCHAR(255) NOT NULL,
    key_prefix VARCHAR(16) NOT NULL,
    key_hash VARCHAR(255) NOT NULL,
    name VARCHAR(255) NOT NULL,
    created_by VARCHAR(36) REFERENCES users(id) ON DELETE SET NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
    allowed_origins JSONB,
    revoked_at TIMESTAMP WITH TIME ZONE,
    last_used_at TIMESTAMP WITH TIME ZONE,
    proofs_submitted INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_oracle_credentials_hash ON oracle_credentials(key_hash);
CREATE INDEX IF NOT EXISTS idx_oracle_credentials_community ON oracle_credentials(community_did);

CREATE TABLE IF NOT EXISTS wallet_links (
    id VARCHAR(36) PRIMARY KEY,
    user_did VARCHAR(255) NOT NULL,
    chain VARCHAR(32) NOT NULL,
    wallet_address VARCHAR(255) NOT NULL,
    label VARCHAR(64),
    challenge TEXT NOT NULL,
    signature TEXT NOT NULL,
    linked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    -- Progressive custody tier for this wallet. See migration 021.
    custody_tier TEXT NOT NULL DEFAULT 'self_custody'
        CHECK (custody_tier IN ('custodial', 'user_encrypted', 'self_custody')),
    custody_status TEXT NOT NULL DEFAULT 'active'
        CHECK (custody_status IN ('active', 'exported', 'superseded')),
    UNIQUE(chain, wallet_address),
    UNIQUE(user_did, label)
);
CREATE INDEX IF NOT EXISTS idx_wallet_links_did ON wallet_links(user_did);
CREATE INDEX IF NOT EXISTS idx_wallet_links_address ON wallet_links(chain, wallet_address);
CREATE INDEX IF NOT EXISTS idx_wallet_links_tier ON wallet_links(user_did, custody_tier);

CREATE TABLE IF NOT EXISTS wallet_link_challenges (
    id VARCHAR(36) PRIMARY KEY,
    user_did VARCHAR(255) NOT NULL,
    chain VARCHAR(32) NOT NULL,
    wallet_address VARCHAR(255) NOT NULL,
    challenge TEXT NOT NULL,
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    -- 'link' for BYOW wallet-link proof, 'signin' for SIWOF (migration 022)
    purpose TEXT NOT NULL DEFAULT 'link'
        CHECK (purpose IN ('link', 'signin')),
    -- Audience (dApp origin) the challenge is scoped to; NULL for link.
    audience TEXT
);
CREATE INDEX IF NOT EXISTS idx_wallet_challenges_did ON wallet_link_challenges(user_did);
CREATE INDEX IF NOT EXISTS idx_wallet_challenges_purpose
    ON wallet_link_challenges(user_did, purpose, expires_at);

-- Tier 1 custodial wallet keys. PDS holds the private key, encrypted at rest
-- with KEY_ENCRYPTION_SECRET (same AES-256-GCM primitive as signing_keys).
-- Only decrypted in-memory for a single sign() request.
CREATE TABLE IF NOT EXISTS wallet_custody (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_did VARCHAR(255) NOT NULL REFERENCES users(did) ON DELETE CASCADE,
    chain VARCHAR(32) NOT NULL,
    wallet_address VARCHAR(255) NOT NULL,
    private_key_encrypted BYTEA NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(user_did, chain, wallet_address)
);
CREATE INDEX IF NOT EXISTS idx_wallet_custody_user_did ON wallet_custody(user_did);

-- OAuth-style per-dApp consent grants authorizing the PDS to sign with Tier 1
-- wallets on behalf of the user. Default TTL 7 days; user can revoke early.
CREATE TABLE IF NOT EXISTS wallet_dapp_consents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_did VARCHAR(255) NOT NULL REFERENCES users(did) ON DELETE CASCADE,
    dapp_origin TEXT NOT NULL,
    chain VARCHAR(32),
    wallet_address VARCHAR(255),
    granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_wallet_consents_lookup
  ON wallet_dapp_consents(user_did, dapp_origin)
  WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_wallet_consents_expiry
  ON wallet_dapp_consents(expires_at)
  WHERE revoked_at IS NULL;

-- Vault shares: Shamir's Secret Sharing for threshold key custody
CREATE TABLE IF NOT EXISTS vault_shares (
    id VARCHAR(36) PRIMARY KEY,
    user_did VARCHAR(255) NOT NULL,
    share_index INTEGER NOT NULL,
    encrypted_share BYTEA NOT NULL,
    share_holder VARCHAR(32) NOT NULL,
    escrow_provider_did VARCHAR(255),
    recovery_tier INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_did, share_index)
);
CREATE INDEX IF NOT EXISTS idx_vault_shares_did ON vault_shares(user_did);

-- Vault audit log: append-only audit trail for vault operations
CREATE TABLE IF NOT EXISTS vault_audit_log (
    id VARCHAR(36) PRIMARY KEY,
    user_did VARCHAR(255) NOT NULL,
    action VARCHAR(64) NOT NULL,
    actor_did VARCHAR(255),
    share_index INTEGER,
    metadata JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_vault_audit_did ON vault_audit_log(user_did);

-- Escrow providers: external key escrow services
CREATE TABLE IF NOT EXISTS escrow_providers (
    id VARCHAR(36) PRIMARY KEY,
    did VARCHAR(255) NOT NULL UNIQUE,
    name VARCHAR(255) NOT NULL,
    verification_url VARCHAR(512),
    public_key TEXT,
    status VARCHAR(20) DEFAULT 'active',
    registered_by VARCHAR(255),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Recovery attempts: tracks identity recovery operations
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

-- Attestation encryption metadata: tracks private attestation DEKs and commitment hashes
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

-- Viewing grants: time-limited selective disclosure grants from attestation subjects
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

-- Disclosure sessions: time-limited access with session-scoped re-encryption
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

-- Disclosure audit log: forensic trail for all disclosure operations
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
