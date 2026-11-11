-- scripts/migrate-056-custody-mode.sql
-- Custody modes (ADR-003): who holds the account's PLC rotation key.
--   custodial: the PDS (shares 2 and 3); assisted: the user first, the PDS
--   second; self: the user only. NULL: no rotation key here and none of the
--   user's either (external accounts, the local bootstrap admin).
ALTER TABLE users ADD COLUMN IF NOT EXISTS custody_mode VARCHAR(16)
  CHECK (custody_mode IN ('custodial', 'assisted', 'self'));
UPDATE users SET custody_mode = 'self' WHERE custody_mode IS NULL AND auth_type = 'pseudonym';
UPDATE users u SET custody_mode = 'custodial'
  WHERE u.custody_mode IS NULL AND u.auth_type = 'local'
    AND EXISTS (SELECT 1 FROM vault_shares s WHERE s.user_did = u.did);
