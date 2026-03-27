import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireApprovedUser } from '../auth/guards.js';
import { RepoEngine } from '../repo/repo-engine.js';
import { getKeypairForDid } from '../repo/keypair-utils.js';
import { auditLog } from '../db/audit.js';
import { query } from '../db/client.js';
import { EXTERNAL_KEY_COLLECTION } from '../identity/external-keys.js';

export default async function deleteExternalKey(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireApprovedUser(req, res)) return;

    const { rkey } = req.body;

    if (!rkey) {
      res.status(400).json({
        error: 'InvalidRequest',
        message: 'Missing required field: rkey',
      });
      return;
    }

    const did = req.auth!.did;

    const existing = await query(
      `SELECT 1 FROM records_index
       WHERE community_did = $1 AND collection = $2 AND rkey = $3`,
      [did, EXTERNAL_KEY_COLLECTION, rkey]
    );

    if (existing.rows.length === 0) {
      res.status(404).json({
        error: 'KeyNotFound',
        message: 'No external key found with the given rkey',
      });
      return;
    }

    const engine = new RepoEngine(did);
    const keypair = await getKeypairForDid(did);
    await engine.deleteRecord(keypair, EXTERNAL_KEY_COLLECTION, rkey);

    await auditLog('identity.deleteExternalKey', req.auth!.userId, did, { rkey });

    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error in deleteExternalKey:', error);
    res.status(500).json({
      error: 'InternalServerError',
      message: 'Failed to delete external key',
    });
  }
}
