import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireRole } from '../auth/guards.js';
import { query, withTransaction } from '../db/client.js';
import { auditLog } from '../db/audit.js';
import { atprotoKeyFor } from '../identity/account-migration.js';
import { RepoImportError, readCarBody, storeRepoImport, verifyRepoImport } from '../repo/import.js';

/**
 * Admin restore of a repository from a CAR backup. The backup is verified
 * against the DID's current atproto key before anything is stored. For an
 * account moving here, the owner uses com.atproto.repo.importRepo instead.
 */
export default async function importRepo(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireRole(req, res, ['admin'])) return;

    const did = req.query.did as string;

    if (!did || !did.startsWith('did:')) {
      res.status(400).json({
        error: 'InvalidRequest',
        message: 'did query parameter is required and must be a valid DID',
      });
      return;
    }

    // Check repo doesn't already exist
    const existingRepo = await query(
      'SELECT 1 FROM repo_roots WHERE did = $1',
      [did]
    );

    if (existingRepo.rows.length > 0) {
      res.status(409).json({
        error: 'RepoAlreadyExists',
        message: `A repository already exists for DID: ${did}`,
      });
      return;
    }

    const carBytes = await readCarBody(req);
    const verified = await verifyRepoImport(did, carBytes, async () => atprotoKeyFor(did));
    await withTransaction((client) => storeRepoImport(client, did, verified, { replace: false }));

    await auditLog('admin.importRepo', req.auth!.userId, did, {
      rootCid: verified.root,
      blockCount: verified.blocks.length,
      recordCount: verified.records.length,
    });

    res.status(200).json({
      did,
      rootCid: verified.root,
      blockCount: verified.blocks.length,
      recordCount: verified.records.length,
    });
  } catch (error) {
    if (error instanceof RepoImportError) {
      res.status(error.status).json({ error: error.code, message: error.message });
      return;
    }
    console.error('Error in importRepo:', error);
    res.status(500).json({
      error: 'InternalServerError',
      message: 'Failed to import repository',
    });
  }
}
