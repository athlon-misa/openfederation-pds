-- scripts/migrate-045-community-migration.sql
-- Community migration (#267, ADR-002).
-- Ownership by DID: the owner may live on any PDS.
ALTER TABLE communities ADD COLUMN IF NOT EXISTS owner_did VARCHAR(255);
UPDATE communities c SET owner_did = u.did FROM users u WHERE c.owner_did IS NULL AND u.id = c.created_by;
CREATE INDEX IF NOT EXISTS idx_communities_owner_did ON communities(owner_did);

-- The public half of the recovery key this PDS holds for the community, to
-- recommend for the PLC update; and where a community arriving here is pulled from.
ALTER TABLE communities ADD COLUMN IF NOT EXISTS recovery_did_key TEXT;
ALTER TABLE communities ADD COLUMN IF NOT EXISTS from_pds TEXT;

-- importing: arriving here, not yet activated. moved: lives elsewhere now.
ALTER TABLE communities DROP CONSTRAINT IF EXISTS communities_status_check;
ALTER TABLE communities ADD CONSTRAINT communities_status_check
  CHECK (status IN ('active', 'suspended', 'takendown', 'importing', 'moved'));
