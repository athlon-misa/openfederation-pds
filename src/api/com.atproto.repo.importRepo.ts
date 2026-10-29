import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireAuth } from '../auth/guards.js';
import { query, withTransaction } from '../db/client.js';
import { atprotoKeyFor } from '../identity/account-migration.js';
import { RepoImportError, readCarBody, storeRepoImport, verifyRepoImport } from '../repo/import.js';

/**
 * AT Protocol importRepo (#262): an account that is moving here loads its
 * own repository from a CAR exported by its old PDS. Allowed only while the
 * account is deactivated and marked as migrating in.
 *
 * The CAR must be signed by the DID's current atproto key, which is the old
 * PDS's key until the DID is pointed here. That is why the standard order is
 * create → import → blobs → PLC update → activate. The import replaces the
 * account's repo in one transaction, so it can be repeated. No audit: the
 * accounts that can move here so far are pseudonyms.
 */
export default async function importRepo(req: AuthRequest, res: Response): Promise<void> {
  if (!requireAuth(req, res)) return;
  if (req.auth.authMethod === 'service-auth') {
    res.status(403).json({ error: 'Forbidden', message: 'Log in to the account to import its repository' });
    return;
  }
  const did = req.auth.did;
  try {
    const user = (await query<{ status: string; migrating_in: boolean }>(
      'SELECT status, migrating_in FROM users WHERE did = $1', [did])).rows[0];
    if (!user || !user.migrating_in || user.status !== 'deactivated') {
      res.status(403).json({ error: 'Forbidden', message: 'Only an account that is moving here and not yet activated can import a repository' });
      return;
    }

    const carBytes = await readCarBody(req);
    const verified = await verifyRepoImport(did, carBytes, () => atprotoKeyFor(did));
    await withTransaction((client) => storeRepoImport(client, did, verified, { replace: true }));
    res.status(200).json({});
  } catch (error) {
    if (error instanceof RepoImportError) {
      res.status(error.status).json({ error: error.code, message: error.message });
      return;
    }
    console.error('Error in importRepo (migration)');
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to import repository' });
  }
}
