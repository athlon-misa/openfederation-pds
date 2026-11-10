-- scripts/migrate-047-prior-status.sql
-- What an account or community was before it was suspended or taken down, so
-- lifting the action puts it back there. Without this, unsuspending always
-- produced 'approved' / 'active': an account that had migrated away
-- ('deactivated') or a community that had moved ('moved') came back live.
ALTER TABLE users ADD COLUMN IF NOT EXISTS prior_status VARCHAR(32);
ALTER TABLE communities ADD COLUMN IF NOT EXISTS prior_status VARCHAR(32);
