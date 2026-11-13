/**
 * The first admin account chosen in the setup wizard (#405).
 *
 * The wizard runs before the server's schema and configuration exist, so it
 * does not create the account itself: it leaves the handle, email and a
 * bcrypt hash of the password in the one `server_setup` row, and the first
 * normal start creates the account from them (exactly as the
 * BOOTSTRAP_ADMIN_* variables would) and clears them. A start that fails
 * before this point leaves them in place, and the next start tries again.
 */
import { withTransaction } from '../db/client.js';
import { provisionAdminAccount } from './bootstrap.js';

export async function completePendingSetupAdmin(): Promise<'none' | 'created' | 'existing'> {
  return withTransaction(async (client) => {
    const table = await client.query<{ t: string | null }>("SELECT to_regclass('public.server_setup')::text AS t");
    if (!table.rows[0]?.t) return 'none';
    const pending = await client.query<{ handle: string; email: string; hash: string }>(
      `SELECT pending_admin_handle AS handle, pending_admin_email AS email, pending_admin_password_hash AS hash
         FROM server_setup
        WHERE id AND pending_admin_password_hash IS NOT NULL
        FOR UPDATE`,
    );
    const row = pending.rows[0];
    if (!row) return 'none';
    const outcome = await provisionAdminAccount(
      { query: (text, params) => client.query(text, params) },
      { handle: row.handle, email: row.email, passwordHash: async () => row.hash, source: 'setup' },
    );
    await client.query(
      `UPDATE server_setup
          SET pending_admin_handle = NULL, pending_admin_email = NULL, pending_admin_password_hash = NULL
        WHERE id`,
    );
    return outcome;
  });
}
