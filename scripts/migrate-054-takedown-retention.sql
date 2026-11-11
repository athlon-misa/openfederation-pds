-- scripts/migrate-054-takedown-retention.sql
-- Takedown policy (docs/FAIR-USE.md): a takedown has a tier (standard: the
-- owner may export for 30 days; hard: no owner export, 90-day legal hold), and
-- a date after which the daily sweep deletes the data.
ALTER TABLE users ADD COLUMN IF NOT EXISTS takedown_tier VARCHAR(16);
ALTER TABLE users ADD COLUMN IF NOT EXISTS takedown_delete_after TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS takedown_reminded_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS takedown_exported_at TIMESTAMPTZ;
ALTER TABLE communities ADD COLUMN IF NOT EXISTS takedown_tier VARCHAR(16);
ALTER TABLE communities ADD COLUMN IF NOT EXISTS takedown_delete_after TIMESTAMPTZ;
ALTER TABLE communities ADD COLUMN IF NOT EXISTS takedown_reminded_at TIMESTAMPTZ;
ALTER TABLE communities ADD COLUMN IF NOT EXISTS takedown_exported_at TIMESTAMPTZ;

-- Private export links mailed to the owner of a taken-down repository. Only
-- the SHA-256 of the token is stored; a link works until the deletion date.
CREATE TABLE IF NOT EXISTS takedown_export_tokens (
    token_hash CHAR(64) PRIMARY KEY,
    subject_did TEXT NOT NULL,
    subject_kind VARCHAR(16) NOT NULL CHECK (subject_kind IN ('account', 'community')),
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_takedown_export_tokens_subject ON takedown_export_tokens(subject_did);
