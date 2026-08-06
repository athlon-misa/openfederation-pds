-- Migration 035: index for tallying governance votes from voter-signed records.
--
-- The authoritative tally for a proposal reads vote records out of every
-- voter's own repo, so it filters records_index by collection + the proposal
-- the record points at, not by a single repo DID. Without this partial index
-- that lookup is a sequential scan of every record in every repo.

CREATE INDEX IF NOT EXISTS idx_records_governance_vote_proposal
    ON records_index ((record->>'community'), (record->>'proposalRkey'))
    WHERE collection = 'net.openfederation.governance.vote';
