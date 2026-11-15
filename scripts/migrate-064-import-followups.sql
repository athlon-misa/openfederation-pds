-- scripts/migrate-064-import-followups.sql
-- Import follow-ups (#403).
--
-- 1. Community invite codes: an invite code can name a community. Used at
--    sign-up, the new account also joins it (or asks to, under an approval
--    join policy). NULL: a plain sign-up code, as before.
ALTER TABLE invites ADD COLUMN IF NOT EXISTS community_did TEXT;
CREATE INDEX IF NOT EXISTS idx_invites_community ON invites(community_did) WHERE community_did IS NOT NULL;

-- 2. Joins waiting on a community invite code: written in the sign-up
--    transaction, applied once the account is approved (at once when
--    ACCOUNT_APPROVAL=automatic, else when an admin approves it), then removed.
CREATE TABLE IF NOT EXISTS invite_community_joins (
    user_id VARCHAR(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    community_did TEXT NOT NULL,
    invite_code VARCHAR(64) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, community_did)
);

-- 3. Imported records that were deleted: their record key, which the import
--    derives from the source id, so net.openfederation.forum.importBatch
--    does not bring them back when an import is run again.
CREATE TABLE IF NOT EXISTS forum_import_tombstones (
    community_did TEXT NOT NULL,
    collection TEXT NOT NULL,
    rkey TEXT NOT NULL,
    platform TEXT NOT NULL,
    deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (community_did, collection, rkey)
);
