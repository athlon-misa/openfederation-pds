-- Email delivery outcomes and suppression list (#83).
--
-- `email_deliveries` is the observable record of every send attempt-set —
-- previously a failed or unconfigured send vanished without trace, so
-- password reset could report success while delivering nothing. Bodies are
-- never stored: reset/recovery emails carry live secret URLs, the same
-- tokens the database deliberately holds only as hashes.
--
-- `email_suppressions` holds addresses mail must no longer go to (hard
-- bounces, complaints), written by provider webhooks and checked before
-- every send.

CREATE TABLE IF NOT EXISTS email_deliveries (
    id VARCHAR(36) PRIMARY KEY,
    recipient VARCHAR(255) NOT NULL,
    purpose VARCHAR(40) NOT NULL,
    status VARCHAR(20) NOT NULL,
    provider_message_id VARCHAR(255),
    error TEXT,
    attempts INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_email_deliveries_recipient ON email_deliveries(recipient, created_at);
CREATE INDEX IF NOT EXISTS idx_email_deliveries_status ON email_deliveries(status, created_at);

CREATE TABLE IF NOT EXISTS email_suppressions (
    recipient VARCHAR(255) PRIMARY KEY,
    reason VARCHAR(40) NOT NULL,
    source VARCHAR(40) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
