-- scripts/migrate-060-device-signing.sql
-- Device signing (#240, ADR-003 decision 14): the person's device holds the
-- repo signing key and the DID's `atproto` verification method names it, so
-- this server can no longer sign commits for the account.
--   device_signing:     on only after the server checked that PLC's atproto
--                       key is not its own key for the DID. While on, every
--                       server-side write into the account's repo refuses.
--   device_signing_key: the did:key PLC named when it was turned on (shown to
--                       the person; submitCommit always re-reads PLC instead).
ALTER TABLE users ADD COLUMN IF NOT EXISTS device_signing BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS device_signing_key TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS device_signing_since TIMESTAMPTZ;

-- Commits prepared for the device to sign (net.openfederation.repo.prepareCommit).
-- Bound to the account and to the repo head they were built on; consumed by
-- submitCommit (deleted on first use), expire after a few minutes, and capped
-- per account.
CREATE TABLE IF NOT EXISTS pending_device_commits (
    id CHAR(32) PRIMARY KEY,
    did TEXT NOT NULL,
    prev_root TEXT NOT NULL,
    since TEXT,
    rev TEXT NOT NULL,
    unsigned_commit BYTEA NOT NULL,
    new_blocks JSONB NOT NULL,
    removed_cids TEXT[] NOT NULL,
    index_ops JSONB NOT NULL,
    results JSONB NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pending_device_commits_did ON pending_device_commits(did);
CREATE INDEX IF NOT EXISTS idx_pending_device_commits_expires ON pending_device_commits(expires_at);
