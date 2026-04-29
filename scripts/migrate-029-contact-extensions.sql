-- migrate-029-contact-extensions.sql
-- Contact graph extensions: blocks (#71), FoF opt-in (#72), notifications (#70)

-- Block list (blocker's repo holds the record)
CREATE TABLE IF NOT EXISTS contact_blocks (
  blocker_did VARCHAR(255) NOT NULL,
  blocked_did VARCHAR(255) NOT NULL,
  rkey        VARCHAR(255) NOT NULL,
  created_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  PRIMARY KEY (blocker_did, blocked_did)
);

CREATE INDEX IF NOT EXISTS idx_contact_blocks_blocked_did
  ON contact_blocks(blocked_did);

-- Friend-of-friend discovery opt-in flag (#72)
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS fof_discovery BOOLEAN NOT NULL DEFAULT FALSE;

-- Generic notification inbox (#70)
CREATE TABLE IF NOT EXISTS notifications (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_did VARCHAR(255) NOT NULL,
  category      VARCHAR(64)  NOT NULL,
  payload       JSONB        NOT NULL DEFAULT '{}',
  created_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  read_at       TIMESTAMP WITH TIME ZONE
);

CREATE INDEX IF NOT EXISTS idx_notifications_recipient
  ON notifications(recipient_did, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_notifications_unread
  ON notifications(recipient_did, category)
  WHERE read_at IS NULL;
