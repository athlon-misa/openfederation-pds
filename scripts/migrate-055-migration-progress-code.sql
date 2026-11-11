-- scripts/migrate-055-migration-progress-code.sql
-- While a community is importing, checkMigration answers only its owner, an
-- admin, or whoever holds the progress code migrateIn returned. Only the
-- SHA-256 of the code is stored; each migrateIn call issues a new one.
ALTER TABLE communities ADD COLUMN IF NOT EXISTS migration_code_hash CHAR(64);
