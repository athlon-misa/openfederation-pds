-- First-run setup wizard (#405).
--
-- One row, written when someone finishes the setup wizard. It is what keeps
-- the wizard locked: a server whose settings file has gone missing but whose
-- database has this row refuses to offer setup again (that would generate new
-- secrets and orphan every key encrypted under the old ones).
--
-- The pending_admin_* columns carry the first admin account from the wizard to
-- the normal start that follows it, which creates the account and clears
-- them. The password is only ever stored as a bcrypt hash.
--
-- The wizard creates this table itself (it runs before the schema exists), so
-- this statement must stay identical to the one in src/setup/setup-store.ts.
CREATE TABLE IF NOT EXISTS server_setup (
  id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  completed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  config_file TEXT NOT NULL,
  pending_admin_handle TEXT,
  pending_admin_email TEXT,
  pending_admin_password_hash TEXT
);
