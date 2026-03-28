-- Migration 008: Export schedules for automated community backups
-- Date: 2026-03-27

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
