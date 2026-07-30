CREATE TABLE IF NOT EXISTS blob_owners (
    cid TEXT NOT NULL REFERENCES blobs(cid) ON DELETE CASCADE,
    did TEXT NOT NULL,
    PRIMARY KEY (cid, did)
);

CREATE INDEX IF NOT EXISTS idx_blob_owners_did ON blob_owners(did);

INSERT INTO blob_owners (cid, did)
SELECT cid, did FROM blobs
ON CONFLICT (cid, did) DO NOTHING;
