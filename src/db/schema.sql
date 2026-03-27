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
    exported_at TIMESTAMP WITH TIME ZONE
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
    uses_count INTEGER NOT NULL DEFAULT 0
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
