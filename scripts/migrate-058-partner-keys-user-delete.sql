-- scripts/migrate-058-partner-keys-user-delete.sql
-- partner_keys.created_by / revoked_by referenced users with no delete rule,
-- so deleting an account that had ever created or revoked a partner key
-- failed. The key outlives the person: keep it, forget who made it, as the
-- other created_by columns do.
ALTER TABLE partner_keys DROP CONSTRAINT IF EXISTS partner_keys_created_by_fkey;
ALTER TABLE partner_keys DROP CONSTRAINT IF EXISTS partner_keys_revoked_by_fkey;
ALTER TABLE partner_keys
  ADD CONSTRAINT partner_keys_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  ADD CONSTRAINT partner_keys_revoked_by_fkey FOREIGN KEY (revoked_by) REFERENCES users(id) ON DELETE SET NULL;
