import { Response } from 'express';
import type { AuthRequest, AuthContext } from '../auth/types.js';
import { requireAuth, requireCommunityRole } from '../auth/guards.js';
import { RepoEngine } from '../repo/repo-engine.js';
import { getKeypairForDid } from '../repo/keypair-utils.js';
import { auditLog } from '../db/audit.js';
import { query } from '../db/client.js';

const ATTESTATION_COLLECTION = 'net.openfederation.community.attestation';

export default async function deleteAttestation(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireAuth(req, res)) return;

    const { communityDid, rkey, reason } = req.body;

    if (!communityDid || !rkey) {
      res.status(400).json({
        error: 'InvalidRequest',
        message: 'Missing required fields: communityDid, rkey',
      });
      return;
    }

    const callerRole = await requireCommunityRole(
      req as AuthRequest & { auth: AuthContext },
      res, communityDid, ['owner', 'moderator']
    );
    if (callerRole === null) return;

    const existing = await query(
      `SELECT 1 FROM records_index WHERE community_did = $1 AND collection = $2 AND rkey = $3`,
      [communityDid, ATTESTATION_COLLECTION, rkey]
    );

    if (existing.rows.length === 0) {
      res.status(404).json({
        error: 'AttestationNotFound',
        message: 'No attestation found with the given rkey',
      });
      return;
    }

    const engine = new RepoEngine(communityDid);
    const keypair = await getKeypairForDid(communityDid);
    await engine.deleteRecord(keypair, ATTESTATION_COLLECTION, rkey);

    await auditLog('community.deleteAttestation', req.auth!.userId, communityDid, {
      rkey, ...(reason ? { reason } : {}),
    });

    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error in deleteAttestation:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to delete attestation' });
  }
}
