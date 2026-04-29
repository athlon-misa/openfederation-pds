-- migrate-028-contacts.sql
-- Bidirectional contact graph (issue #67)

-- Pending contact requests (record lives on requester's repo)
CREATE TABLE IF NOT EXISTS contact_requests (
  from_did   VARCHAR(255) NOT NULL,
  to_did     VARCHAR(255) NOT NULL,
  rkey       VARCHAR(255) NOT NULL,
  note       TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  PRIMARY KEY (from_did, to_did)
);

CREATE INDEX IF NOT EXISTS idx_contact_requests_to_did
  ON contact_requests(to_did);

-- Accepted contacts — one row per direction, each party holds a record
CREATE TABLE IF NOT EXISTS contacts (
  user_did    VARCHAR(255) NOT NULL,
  contact_did VARCHAR(255) NOT NULL,
  rkey        VARCHAR(255) NOT NULL,
  accepted_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  tags        JSONB,
  PRIMARY KEY (user_did, contact_did)
);

CREATE INDEX IF NOT EXISTS idx_contacts_contact_did
  ON contacts(contact_did);
