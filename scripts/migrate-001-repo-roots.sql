-- Migration 001: Add repo_roots table and update repo_blocks for MST storage
-- Date: 2026-02-25
-- Purpose: Support real AT Protocol MST repos with signed commits

-- Track repo root CID and current revision per DID
CREATE TABLE IF NOT EXISTS repo_roots (
  did TEXT PRIMARY KEY,
  root_cid TEXT NOT NULL,
  rev TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- Add rev column to repo_blocks for garbage collection
ALTER TABLE repo_blocks ADD COLUMN IF NOT EXISTS rev TEXT;

-- Index for efficient block lookups by DID + CID (already primary key, but also useful for rev-based queries)
CREATE INDEX IF NOT EXISTS idx_repo_blocks_rev ON repo_blocks(community_did, rev);
