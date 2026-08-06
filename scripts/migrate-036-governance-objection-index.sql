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

CREATE INDEX IF NOT EXISTS idx_records_governance_objection_proposal
    ON records_index ((record->>'community'), (record->>'proposalRkey'))
    WHERE collection = 'net.openfederation.governance.objection';
