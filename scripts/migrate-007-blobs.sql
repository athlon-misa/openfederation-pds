-- Migration 007: Add blobs table for binary asset storage
-- Run: psql -h $DB_HOST -U $DB_USER -d $DB_NAME -f scripts/migrate-007-blobs.sql

CREATE TABLE IF NOT EXISTS blobs (
    cid TEXT PRIMARY KEY,
    did TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_blobs_did ON blobs(did);
