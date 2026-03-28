import { Response } from 'express';
import type { AuthRequest, AuthContext } from '../auth/types.js';
import { requireAuth, requireCommunityPermission } from '../auth/guards.js';
import { RepoEngine } from '../repo/repo-engine.js';
import { getKeypairForDid } from '../repo/keypair-utils.js';
import { auditLog } from '../db/audit.js';
import { query } from '../db/client.js';

const ATTESTATION_COLLECTION = 'net.openfederation.community.attestation';
const VALID_TYPES = ['membership', 'role', 'credential'];

export default async function issueAttestation(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireAuth(req, res)) return;

    const { communityDid, subjectDid, subjectHandle, type, claim, expiresAt } = req.body;

    if (!communityDid || !subjectDid || !subjectHandle || !type || !claim) {
      res.status(400).json({
        error: 'InvalidRequest',
        message: 'Missing required fields: communityDid, subjectDid, subjectHandle, type, claim',
      });
      return;
    }

    if (!VALID_TYPES.includes(type)) {
      res.status(400).json({
        error: 'InvalidRequest',
        message: `type must be one of: ${VALID_TYPES.join(', ')}`,
      });
      return;
    }

    if (typeof claim !== 'object' || claim === null || Array.isArray(claim)) {
      res.status(400).json({
        error: 'InvalidRequest',
        message: 'claim must be a JSON object',
      });
      return;
    }

    const hasPermission = await requireCommunityPermission(
      req as AuthRequest & { auth: AuthContext },
      res, communityDid, 'community.attestation.write'
    );
    if (!hasPermission) return;

    const memberResult = await query(
      'SELECT 1 FROM members_unique WHERE community_did = $1 AND member_did = $2',
      [communityDid, subjectDid]
    );

    if (memberResult.rows.length === 0) {
      res.status(404).json({
        error: 'NotMember',
        message: 'Subject is not a member of this community',
      });
      return;
    }

    const engine = new RepoEngine(communityDid);
    const keypair = await getKeypairForDid(communityDid);
    const rkey = RepoEngine.generateTid();

    const record = {
      subjectDid,
      subjectHandle,
      type,
      claim,
      issuedAt: new Date().toISOString(),
      ...(expiresAt ? { expiresAt } : {}),
    };

    const result = await engine.putRecord(keypair, ATTESTATION_COLLECTION, rkey, record);

    await auditLog('community.issueAttestation', req.auth!.userId, communityDid, {
      subjectDid, type, rkey,
    });

    res.status(200).json({ uri: result.uri, cid: result.cid, rkey });
  } catch (error) {
    console.error('Error in issueAttestation:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to issue attestation' });
  }
}
