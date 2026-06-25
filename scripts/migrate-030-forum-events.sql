-- scripts/migrate-030-forum-events.sql
-- Aggregation index for community forum threads/posts and event RSVPs.
-- Source of truth remains the repos (repo_blocks); these tables are a
-- denormalized read cache, rebuildable via scripts/backfill-forum-index.ts.

CREATE TABLE IF NOT EXISTS forum_threads (
    uri            TEXT PRIMARY KEY,
    cid            TEXT NOT NULL,
    community_did  TEXT NOT NULL,
    author_did     TEXT NOT NULL,
    title          TEXT NOT NULL,
    tags           TEXT[] NOT NULL DEFAULT '{}',
    post_count     INTEGER NOT NULL DEFAULT 0,
    last_activity  TIMESTAMPTZ NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL,
    hidden         BOOLEAN NOT NULL DEFAULT false,
    indexed_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_forum_threads_community
    ON forum_threads(community_did, last_activity DESC);

CREATE TABLE IF NOT EXISTS forum_posts (
    uri              TEXT PRIMARY KEY,
    cid              TEXT NOT NULL,
    community_did    TEXT NOT NULL,
    author_did       TEXT NOT NULL,
    thread_root_uri  TEXT NOT NULL,
    parent_uri       TEXT,
    record           JSONB NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL,
    hidden           BOOLEAN NOT NULL DEFAULT false,
    indexed_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_forum_posts_thread ON forum_posts(thread_root_uri, created_at);
CREATE INDEX IF NOT EXISTS idx_forum_posts_parent ON forum_posts(parent_uri);
CREATE INDEX IF NOT EXISTS idx_forum_posts_author ON forum_posts(author_did);

CREATE TABLE IF NOT EXISTS event_rsvps (
    uri          TEXT PRIMARY KEY,
    event_uri    TEXT NOT NULL,
    attendee_did TEXT NOT NULL,
    status       TEXT NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL,
    UNIQUE(event_uri, attendee_did)
);
CREATE INDEX IF NOT EXISTS idx_event_rsvps_event ON event_rsvps(event_uri, status);
