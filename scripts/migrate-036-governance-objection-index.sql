-- Migration 036: index for finding governance objections from objector-signed
-- records.
--
-- Sibling of migration 035, and needed for the same reason. Deciding whether a
-- passed proposal's application is held reads objection records out of every
-- objector's own repo, so it filters records_index by collection + the proposal
-- the record points at, not by a single repo DID. Migration 035's index is
-- partial on the vote collection and does not apply here, and
-- idx_records_community_collection is keyed on the repo DID rather than the
-- community named in the record body.
--
-- Without this, the lookup is a sequential scan of every record in every repo on
-- the PDS — reachable from an unauthenticated getProposal / listProposals on a
-- public community with a due proposal, because application is evaluated lazily
-- on those read paths.

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

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_records_governance_objection_proposal
    ON records_index ((record->>'community'), (record->>'proposalRkey'))
    WHERE collection = 'net.openfederation.governance.objection';
