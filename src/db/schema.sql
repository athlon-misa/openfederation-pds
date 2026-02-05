-- OpenFederation PDS Database Schema
-- Version: 1.0
-- Date: 2026-02-05

-- Communities table: stores basic community information
CREATE TABLE IF NOT EXISTS communities (
    did VARCHAR(255) PRIMARY KEY,
    handle VARCHAR(255) UNIQUE NOT NULL,
    did_method VARCHAR(10) NOT NULL CHECK (did_method IN ('plc', 'web')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_communities_handle ON communities(handle);

-- PLC Keys table: stores encrypted recovery keys for did:plc communities
-- IMPORTANT: The recovery_key_bytes should be encrypted at rest
CREATE TABLE IF NOT EXISTS plc_keys (
    community_did VARCHAR(255) PRIMARY KEY REFERENCES communities(did) ON DELETE CASCADE,
    recovery_key_bytes BYTEA NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Repository Blocks table: stores raw blocks (authoritative storage)
-- This is the source of truth for all repository data
CREATE TABLE IF NOT EXISTS repo_blocks (
    community_did VARCHAR(255) NOT NULL REFERENCES communities(did) ON DELETE CASCADE,
    cid VARCHAR(255) NOT NULL,
    block_bytes BYTEA NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (community_did, cid)
);

CREATE INDEX idx_repo_blocks_community ON repo_blocks(community_did);

-- Records Index table: provides fast lookup of current records
-- This is a convenience index; repo_blocks is authoritative
CREATE TABLE IF NOT EXISTS records_index (
    id SERIAL PRIMARY KEY,
    community_did VARCHAR(255) NOT NULL REFERENCES communities(did) ON DELETE CASCADE,
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
