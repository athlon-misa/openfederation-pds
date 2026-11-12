-- scripts/migrate-059-activity-indexes.sql
-- Indexes for the activity feed (#42, src/activity/feed.ts): each source is
-- filtered by community, and on later pages by created_at (the cursor), so
-- the cursor bound becomes an index condition instead of a filter over every
-- row of the community. Partial, so they hold only the rows the feed reads.
--
-- members_unique already has idx_members_community, and the planner keeps
-- using it with a (community_did, created_at) index present, so none is added.

-- Pending join requests (the only status the feed reads).
CREATE INDEX IF NOT EXISTS idx_join_requests_pending_created
    ON join_requests (community_did, created_at DESC)
    WHERE status = 'pending';

-- Proposals and calendar events in records_index; every other collection is
-- left out, so other writes do not maintain this index.
CREATE INDEX IF NOT EXISTS idx_records_activity_created
    ON records_index (community_did, collection, created_at DESC)
    WHERE collection IN ('net.openfederation.community.proposal', 'community.lexicon.calendar.event');

-- Forum threads that are not hidden (idx_forum_threads_community is ordered
-- by last_activity, for the thread list).
CREATE INDEX IF NOT EXISTS idx_forum_threads_community_created
    ON forum_threads (community_did, created_at DESC)
    WHERE hidden = false;
