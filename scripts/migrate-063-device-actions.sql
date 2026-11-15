-- scripts/migrate-063-device-actions.sql
-- Device-signed actions (#240 phase 2): a prepared signature can belong to a
-- method (net.openfederation.repo.prepareAction), not only to a set of record
-- writes. submitCommit then runs that method again with the device's
-- signature in place.
--   kind:          'commit' (the device signs unsigned_commit, a repo commit)
--                  or 'authorSig' (the device signs unsigned_commit, the CID
--                  of author_record, a record kept in a private community's
--                  repository).
--   action:        { method, input, ops } for prepareAction; NULL for
--                  prepareCommit.
--   author_record: kind 'authorSig': { repo, collection, rkey, record }.
ALTER TABLE pending_device_commits ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'commit';
ALTER TABLE pending_device_commits ADD COLUMN IF NOT EXISTS action JSONB;
ALTER TABLE pending_device_commits ADD COLUMN IF NOT EXISTS author_record JSONB;
