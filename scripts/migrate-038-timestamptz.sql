-- Put every remaining timestamp on the same clock (#221).
--
-- Fifteen columns were `timestamp WITHOUT time zone`, and the two things
-- written into them disagreed about which clock they meant:
--
--   * Postgres defaults and comparisons (CURRENT_TIMESTAMP, NOW()) produce
--     local wall-clock time in the server's timezone.
--   * The application passes a JS Date, which the pg driver serialises as UTC.
--
-- Where both sides were Postgres the mismatch cancelled out and nothing was
-- wrong. Where the application wrote the value and Postgres compared it, the
-- credential's real lifetime became `TTL - UTC offset`:
-- `viewing_grants.expires_at` is written from a JS Date and compared against
-- NOW() in four places, so at UTC+3 a 60-minute disclosure grant was born two
-- hours expired, and at UTC-4 it stayed redeemable four hours past its stated
-- expiry. Railway runs UTC, where the offset is zero, which is why this was
-- invisible in the only deployment that matters so far.
--
-- Converting the columns removes the class of bug rather than the instance: a
-- timestamptz means the same instant whoever writes it.
--
-- THE `USING` CLAUSE IS LOAD-BEARING. A plain `ALTER ... TYPE timestamptz`
-- interprets the existing naive values as being in the *server's* timezone. For
-- the columns Postgres itself wrote, that is exactly right. For the columns the
-- application wrote, it is wrong by the offset, and would silently shift every
-- stored instant — so those state `AT TIME ZONE 'UTC'` explicitly. On a UTC
-- server the two are identical and this migration is a no-op on the data; on
-- any other server the distinction is the whole point.

BEGIN;

-- ── Written by the application as UTC ────────────────────────────────
--
-- `attestation/lifecycle.ts` passes a JS Date (viewing_grants) and an ISO
-- string (disclosure_sessions.expires_at). Only `viewing_grants.expires_at` is
-- compared against NOW() today; the disclosure session's expiry is currently
-- only read back, and is converted with it so it cannot become the same bug the
-- first time someone adds the obvious check.

ALTER TABLE viewing_grants
  ALTER COLUMN expires_at TYPE TIMESTAMPTZ USING expires_at AT TIME ZONE 'UTC';

ALTER TABLE disclosure_sessions
  ALTER COLUMN expires_at TYPE TIMESTAMPTZ USING expires_at AT TIME ZONE 'UTC';

-- ── Written by Postgres in the server's timezone ─────────────────────
--
-- DEFAULT CURRENT_TIMESTAMP, or an explicit NOW() at the insert. These were
-- never wrong — they were compared against the same clock they were written on
-- — and they are converted so that the schema has one convention and no future
-- writer has to know which of the two a given column is on.

ALTER TABLE viewing_grants        ALTER COLUMN created_at       TYPE TIMESTAMPTZ;
ALTER TABLE disclosure_sessions   ALTER COLUMN created_at       TYPE TIMESTAMPTZ;
ALTER TABLE disclosure_sessions   ALTER COLUMN last_accessed_at TYPE TIMESTAMPTZ;
ALTER TABLE disclosure_audit_log  ALTER COLUMN created_at       TYPE TIMESTAMPTZ;
ALTER TABLE attestation_encryption ALTER COLUMN created_at      TYPE TIMESTAMPTZ;
ALTER TABLE wallet_link_challenges ALTER COLUMN expires_at      TYPE TIMESTAMPTZ;
ALTER TABLE wallet_link_challenges ALTER COLUMN created_at      TYPE TIMESTAMPTZ;
ALTER TABLE wallet_links          ALTER COLUMN linked_at        TYPE TIMESTAMPTZ;
ALTER TABLE vault_shares          ALTER COLUMN created_at       TYPE TIMESTAMPTZ;
ALTER TABLE vault_shares          ALTER COLUMN updated_at       TYPE TIMESTAMPTZ;
ALTER TABLE vault_audit_log       ALTER COLUMN created_at       TYPE TIMESTAMPTZ;
ALTER TABLE escrow_providers      ALTER COLUMN created_at       TYPE TIMESTAMPTZ;
ALTER TABLE proof_verifications   ALTER COLUMN verified_at      TYPE TIMESTAMPTZ;

COMMIT;
