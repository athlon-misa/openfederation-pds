-- Migration 027: write-time member display projection (issue #66)
--
-- Adds display fields to members_unique so listMembers can be served
-- from a single SELECT without joining records_index at read time.
-- Adds community_attestation_index for the same pattern on attestations.

-- Extend members_unique with projection columns
ALTER TABLE members_unique
  ADD COLUMN IF NOT EXISTS display_name TEXT,
  ADD COLUMN IF NOT EXISTS avatar_url   TEXT,
  ADD COLUMN IF NOT EXISTS role         VARCHAR(255),
  ADD COLUMN IF NOT EXISTS role_rkey    VARCHAR(255),
  ADD COLUMN IF NOT EXISTS kind         VARCHAR(255),
  ADD COLUMN IF NOT EXISTS tags         JSONB,
  ADD COLUMN IF NOT EXISTS attributes   JSONB;

-- Back-fill display_name for existing rows using handle from the member record
-- (no profile data available at migration time, so handle is the best we have)
UPDATE members_unique mu
SET display_name = COALESCE(
  (SELECT r.record->>'handle'
   FROM records_index r
   WHERE r.community_did = mu.community_did
     AND r.collection = 'net.openfederation.community.member'
     AND r.rkey = mu.record_rkey
   LIMIT 1),
  mu.member_did  -- absolute fallback: use DID
),
role = COALESCE(
  (SELECT r.record->>'role'
   FROM records_index r
   WHERE r.community_did = mu.community_did
     AND r.collection = 'net.openfederation.community.member'
     AND r.rkey = mu.record_rkey
   LIMIT 1),
  'member'
),
role_rkey = (
  SELECT r.record->>'roleRkey'
  FROM records_index r
  WHERE r.community_did = mu.community_did
    AND r.collection = 'net.openfederation.community.member'
    AND r.rkey = mu.record_rkey
  LIMIT 1
),
kind = (
  SELECT r.record->>'kind'
  FROM records_index r
  WHERE r.community_did = mu.community_did
    AND r.collection = 'net.openfederation.community.member'
    AND r.rkey = mu.record_rkey
  LIMIT 1
),
tags = (
  SELECT r.record->'tags'
  FROM records_index r
  WHERE r.community_did = mu.community_did
    AND r.collection = 'net.openfederation.community.member'
    AND r.rkey = mu.record_rkey
  LIMIT 1
),
attributes = (
  SELECT r.record->'attributes'
  FROM records_index r
  WHERE r.community_did = mu.community_did
    AND r.collection = 'net.openfederation.community.member'
    AND r.rkey = mu.record_rkey
  LIMIT 1
)
WHERE display_name IS NULL;

-- Attestation index: one row per attestation, carries resolved display fields
CREATE TABLE IF NOT EXISTS community_attestation_index (
  community_did        VARCHAR(255) NOT NULL REFERENCES communities(did) ON DELETE CASCADE,
  rkey                 VARCHAR(255) NOT NULL,
  subject_did          VARCHAR(255) NOT NULL,
  subject_handle       VARCHAR(255) NOT NULL,
  subject_display_name TEXT        NOT NULL,
  subject_avatar_url   TEXT,
  type                 VARCHAR(255) NOT NULL,
  claim                JSONB,
  issued_at            TIMESTAMP WITH TIME ZONE NOT NULL,
  expires_at           TIMESTAMP WITH TIME ZONE,
  PRIMARY KEY (community_did, rkey)
);

CREATE INDEX IF NOT EXISTS idx_att_index_community ON community_attestation_index(community_did);
CREATE INDEX IF NOT EXISTS idx_att_index_subject   ON community_attestation_index(community_did, subject_did);
CREATE INDEX IF NOT EXISTS idx_att_index_type      ON community_attestation_index(community_did, type);
