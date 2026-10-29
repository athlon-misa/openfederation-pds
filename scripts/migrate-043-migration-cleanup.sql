-- scripts/migrate-043-migration-cleanup.sql
-- Migration clean-up (#265): a copy that never activated here is removed
-- only after two sweeps in a row found its DID pointing elsewhere. A flag,
-- not a timestamp, so nothing records when a pseudonym was seen.
ALTER TABLE users ADD COLUMN IF NOT EXISTS seen_elsewhere BOOLEAN NOT NULL DEFAULT false;
