-- Migration 035: index for tallying governance votes from voter-signed records.
--
-- The authoritative tally for a proposal reads vote records out of every
-- voter's own repo, so it filters records_index by collection + the proposal
-- the record points at, not by a single repo DID. Without this partial index
-- that lookup is a sequential scan of every record in every repo.

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

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_records_governance_vote_proposal
    ON records_index ((record->>'community'), (record->>'proposalRkey'))
    WHERE collection = 'net.openfederation.governance.vote';
