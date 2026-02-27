-- Migration 002: User signing keys + remove FK constraints for user repos
--
-- Users now get real did:plc identities with signing keys for personal repos.
-- repo_blocks and records_index FK constraints to communities(did) are removed
-- so they can store both community and user repo data.
--
-- Run: psql -U pds_user -d openfederation_pds -f scripts/migrate-002-user-signing-keys.sql

-- 1. User signing keys table
CREATE TABLE IF NOT EXISTS user_signing_keys (
  user_did TEXT PRIMARY KEY,
  signing_key_bytes BYTEA NOT NULL,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- 2. Remove FK constraints from repo_blocks so user DIDs can store blocks
-- The constraint name varies; try the most common patterns
ALTER TABLE repo_blocks DROP CONSTRAINT IF EXISTS repo_blocks_community_did_fkey;
ALTER TABLE repo_blocks DROP CONSTRAINT IF EXISTS fk_repo_blocks_community;

-- 3. Remove FK constraints from records_index so user DIDs can store records
ALTER TABLE records_index DROP CONSTRAINT IF EXISTS records_index_community_did_fkey;
ALTER TABLE records_index DROP CONSTRAINT IF EXISTS fk_records_index_community;

-- 4. Add rev column to repo_blocks if not already present (from migration 001)
ALTER TABLE repo_blocks ADD COLUMN IF NOT EXISTS rev TEXT;
CREATE INDEX IF NOT EXISTS idx_repo_blocks_rev ON repo_blocks(community_did, rev);

-- 5. Create repo_roots table if not already present (from migration 001)
CREATE TABLE IF NOT EXISTS repo_roots (
  did TEXT PRIMARY KEY,
  root_cid TEXT NOT NULL,
  rev TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
