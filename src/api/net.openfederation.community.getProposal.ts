import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireCommunityReadable } from '../auth/guards.js';
import { query } from '../db/client.js';
import { applyIfDue } from '../governance/timelock.js';

const PROPOSAL_COLLECTION = 'net.openfederation.community.proposal';

export default async function getProposal(req: AuthRequest, res: Response): Promise<void> {
  try {
    const communityDid = req.query.communityDid as string;
    const rkey = req.query.rkey as string;

    if (!communityDid || !rkey) {
      res.status(400).json({ error: 'InvalidRequest', message: 'communityDid and rkey parameters are required' });
      return;
    }

    if (!(await requireCommunityReadable(req, res, communityDid))) return;

    // Time-based transitions are evaluated on access (see `timelock.ts`): if
    // this proposal's contest window has elapsed unobjected, the change is
    // applied now, so the caller never reads a stale `pending-application`.
    // Failures are swallowed inside — a stuck application must not break a read.
    try {
      await applyIfDue({ communityDid, proposalRkey: rkey });
    } catch (error) {
      console.error(`[governance] timelock evaluation failed for ${communityDid}/${rkey}:`, error);
    }

    const result = await query<{ record: any }>(
      `SELECT record FROM records_index WHERE community_did = $1 AND collection = $2 AND rkey = $3`,
      [communityDid, PROPOSAL_COLLECTION, rkey]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'ProposalNotFound', message: 'No proposal found with the given rkey' });
      return;
    }

    res.status(200).json({
      uri: `at://${communityDid}/${PROPOSAL_COLLECTION}/${rkey}`,
      rkey,
      ...result.rows[0].record,
    });
  } catch (error) {
    console.error('Error in getProposal:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to get proposal' });
  }
}
