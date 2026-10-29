import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireAuth } from '../auth/guards.js';
import { query } from '../db/client.js';
import { config } from '../config.js';
import { getKeypairForDid } from '../repo/keypair-utils.js';
import { currentPlcState, pointsHere } from '../identity/account-migration.js';

/**
 * AT Protocol checkAccountStatus: how far an account is through import or
 * activation. Callable by the account itself, also while deactivated, so a
 * migration client can poll it at every step.
 */
export default async function checkAccountStatus(req: AuthRequest, res: Response): Promise<void> {
  if (!requireAuth(req, res)) return;
  const did = req.auth.did;
  try {
    const user = (await query<{ status: string }>('SELECT status FROM users WHERE did = $1', [did])).rows[0];
    const root = (await query<{ root_cid: string; rev: string }>(
      'SELECT root_cid, rev FROM repo_roots WHERE did = $1', [did])).rows[0];
    if (!user || !root) {
      res.status(404).json({ error: 'InvalidRequest', message: 'Account has no repository here' });
      return;
    }
    const [blocks, records] = await Promise.all([
      query<{ n: string }>('SELECT COUNT(*) AS n FROM repo_blocks WHERE community_did = $1', [did]),
      query<{ n: string }>('SELECT COUNT(*) AS n FROM records_index WHERE community_did = $1', [did]),
    ]);

    let validDid = false;
    try {
      const state = await currentPlcState(did);
      const keypair = await getKeypairForDid(did);
      validDid = !!state && pointsHere(state, config.pds.serviceUrl, keypair.did());
    } catch {
      validDid = false;
    }

    res.status(200).json({
      activated: user.status === 'approved',
      validDid,
      repoCommit: root.root_cid,
      repoRev: root.rev,
      repoBlocks: Number(blocks.rows[0].n),
      indexedRecords: Number(records.rows[0].n),
      privateStateValues: 0,
      // Blob transfer arrives with #264.
      expectedBlobs: 0,
      importedBlobs: 0,
    });
  } catch (error) {
    console.error('Error in checkAccountStatus');
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to check account status' });
  }
}
