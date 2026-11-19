-- scripts/migrate-066-oidc-remote-email.sql
-- OpenID Connect sign-in with an account of another server (#461): the email
-- that server shared (transition:email), held on the pending request only.
-- The row is deleted when its code is redeemed or the request expires, so the
-- address is never kept after the sign-in.
ALTER TABLE oidc_requests ADD COLUMN IF NOT EXISTS remote_email TEXT;
ALTER TABLE oidc_requests ADD COLUMN IF NOT EXISTS remote_email_verified BOOLEAN NOT NULL DEFAULT FALSE;
