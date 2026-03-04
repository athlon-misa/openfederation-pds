-- Migration 005: User Account Lifecycle Management
-- Adds suspend, takedown, and deactivation support for user accounts
-- Run: psql -f scripts/migrate-005-user-lifecycle.sql

-- Expand status CHECK constraint to include new lifecycle states
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_status_check;
ALTER TABLE users ADD CONSTRAINT users_status_check
  CHECK (status IN ('pending', 'approved', 'rejected', 'disabled', 'suspended', 'takendown', 'deactivated'));

-- Add lifecycle tracking columns
ALTER TABLE users ADD COLUMN IF NOT EXISTS status_changed_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS status_changed_by VARCHAR(36) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS status_reason TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS exported_at TIMESTAMPTZ;
