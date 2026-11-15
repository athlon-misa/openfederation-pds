import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireAuth } from '../auth/guards.js';
import { query, withTransaction } from '../db/client.js';
import { config } from '../config.js';
import { atprotoKeyBeforeOwnMove, atprotoKeyFor } from '../identity/account-migration.js';
import { RepoImportError, readCarBody, storeRepoImport, verifyRepoImport, type VerifiedImport } from '../repo/import.js';

/**
 * AT Protocol importRepo (#262): an account that is moving here loads its
 * own repository from a CAR exported by its old PDS. Allowed while the
 * account is deactivated, which also covers a copy left behind by a move
 * when the account comes back (#265): the CAR must be signed by the DID's
 * current key, so only the real current home's export is accepted.
 *
 * The CAR must be signed by the DID's current atproto key, which is the old
 * PDS's key until the DID is pointed here. That is why the standard order is
 * create → import → blobs → PLC update → activate. The import replaces the
 * account's repo in one transaction, so it can be repeated.
 *
 * One exception (ADR-004, #382): a `self` account that opened here with its
 * top rotation key and has not been activated may also import a repository
 * signed by the key its DID named just before the person moved it here with
 * their own key (atprotoKeyBeforeOwnMove), because after leavePds the old
 * PDS's key is no longer current and that PDS may be gone. Nothing older.
 */
export default async function importRepo(req: AuthRequest, res: Response): Promise<void> {
  if (!requireAuth(req, res)) return;
  if (req.auth.authMethod === 'service-auth') {
    res.status(403).json({ error: 'Forbidden', message: 'Log in to the account to import its repository' });
    return;
  }
  const did = req.auth.did;
  try {
    const user = (await query<{ status: string; migrating_in: boolean; auth_type: string; custody_mode: string | null }>(
      'SELECT status, migrating_in, auth_type, custody_mode FROM users WHERE did = $1', [did])).rows[0];
    if (!user || user.status !== 'deactivated') {
      res.status(403).json({ error: 'Forbidden', message: 'Only a deactivated account can import a repository' });
      return;
    }

    const carBytes = await readCarBody(req);
    let verified: VerifiedImport;
    try {
      verified = await verifyRepoImport(did, carBytes, () => atprotoKeyFor(did));
    } catch (err) {
      // Only an arrival through ADR-004 (createAccount with the rotation key)
      // is a local, `self`, not yet activated incoming account.
      const movedInByRotationKey = user.migrating_in && user.auth_type === 'local' && user.custody_mode === 'self';
      if (!(err instanceof RepoImportError && err.code === 'InvalidSignature') || !movedInByRotationKey) throw err;
      const earlier = await atprotoKeyBeforeOwnMove(did, config.pds.serviceUrl).catch(() => null);
      if (!earlier) throw err;
      try {
        verified = await verifyRepoImport(did, carBytes, async () => earlier);
      } catch (second) {
        if (second instanceof RepoImportError && second.code === 'InvalidSignature') {
          throw new RepoImportError(400, 'InvalidSignature',
            'The commit is signed neither by the DID\'s current atproto key nor by the one it named before you moved it here');
        }
        throw second;
      }
    }

    // An account arriving here replaces an empty placeholder. Any other
    // deactivated account already has a repository with history, and an import
    // may only move it forward: otherwise deactivating, importing an older
    // export and reactivating would erase records (votes, for one) that cannot
    // be deleted any other way.
    if (!user.migrating_in) {
      const current = (await query<{ rev: string }>('SELECT rev FROM repo_roots WHERE did = $1', [did])).rows[0];
      if (current && verified.rev < current.rev) {
        res.status(409).json({
          error: 'RepoRollback',
          message: 'The repository being imported is older than the one already here',
        });
        return;
      }
    }
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
