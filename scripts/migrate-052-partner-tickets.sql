-- scripts/migrate-052-partner-tickets.sql
-- A partner key is sent from browsers, so it cannot prove who is calling. A
-- partner with a backend registers a public key; its backend signs a
-- single-use ticket for each sign-up (see src/auth/partner-ticket.ts).
-- Keys without one still register accounts, but those stay unusable until
-- their email address is verified.
ALTER TABLE partner_keys ADD COLUMN IF NOT EXISTS ticket_public_key TEXT;

CREATE TABLE IF NOT EXISTS partner_ticket_uses (
    partner_key_id VARCHAR(36) NOT NULL REFERENCES partner_keys(id) ON DELETE CASCADE,
    jti VARCHAR(128) NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (partner_key_id, jti)
);
CREATE INDEX IF NOT EXISTS idx_partner_ticket_uses_expiry ON partner_ticket_uses(expires_at);
