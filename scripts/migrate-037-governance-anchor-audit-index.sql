-- Migration 037: index for the anchoring retry queue (#198).
--
-- A failed anchor is recorded as an audit entry, and those entries *are* the
-- retry queue: each resolution in an anchoring community reads its recent
-- `community.proposal.decision.anchorFailed` rows and the matching
-- `...anchored` successes to decide what to try again.
--
-- `idx_audit_log_action` alone makes that a scan of every audit row carrying one
-- of these two actions, across every community on the PDS, on a path that runs
-- inside a member's vote. Scoping the index to the community narrows it to the
-- rows the query actually wants.

-- Built CONCURRENTLY so the index does not block writes while it is created.
-- A plain CREATE INDEX takes a lock that blocks every INSERT/UPDATE/DELETE on
-- the table for the duration of the build, which on a live PDS means nobody can
-- write records while it runs.
--
-- Two consequences of CONCURRENTLY: it cannot run inside a transaction block
-- (so do not wrap this file in BEGIN/COMMIT), and if it fails partway it leaves
-- an INVALID index behind that must be dropped before retrying. Check with:
--
--   SELECT indexrelid::regclass FROM pg_index WHERE NOT indisvalid;
--
-- and drop anything it lists before re-running.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_audit_log_decision_anchor_target
    ON audit_log (target_id, id DESC)
    WHERE action IN ('community.proposal.decision.anchored', 'community.proposal.decision.anchorFailed');
