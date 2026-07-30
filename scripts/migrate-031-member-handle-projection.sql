-- Migration 031: persist member handles in the membership projection.
ALTER TABLE members_unique
  ADD COLUMN IF NOT EXISTS handle VARCHAR(255);

UPDATE members_unique mu
SET handle = COALESCE(
  (SELECT r.record->>'handle'
   FROM records_index r
   WHERE r.community_did = mu.community_did
     AND r.collection = 'net.openfederation.community.member'
     AND r.rkey = mu.record_rkey
   LIMIT 1),
  mu.member_did
)
WHERE handle IS NULL;
