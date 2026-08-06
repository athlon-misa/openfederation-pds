import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireCommunityReadable } from '../auth/guards.js';
import { query } from '../db/client.js';
import {
  applyIfDueSafely, closeExpiredOverrideSafely, countableObjections, communitySettingsRecord,
} from '../governance/timelock.js';
import { objectionThreshold } from '../governance/decision-rules.js';

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
    // A failure is contained and audited inside, never raised — a stuck
    // application must not break a read of the proposal it is stuck on.
    await applyIfDueSafely({ communityDid, proposalRkey: rkey });
    // The override round a hold opens is evaluated the same way and for the same
    // reason: a round whose window has elapsed is closed by the next
    // interaction, so a reader never sees a round that is over (#199).
    await closeExpiredOverrideSafely({ communityDid, proposalRkey: rkey });

    const result = await query<{ record: any }>(
      `SELECT record FROM records_index WHERE community_did = $1 AND collection = $2 AND rkey = $3`,
      [communityDid, PROPOSAL_COLLECTION, rkey]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'ProposalNotFound', message: 'No proposal found with the given rkey' });
      return;
    }

    const record = result.rows[0].record;

    // Objections that have been raised but have not yet reached the threshold
    // are deliberately not written into the proposal record — an unchanged hold
    // is not worth a signed commit per objection. That left them invisible to
    // readers, showing up only in the objecting call's own response, the audit
    // log, and the objector's repo (#202). Reported alongside the threshold so
    // a reader can see a hold forming rather than only its arrival.
    const objections = await pendingObjectionStatus(communityDid, rkey, record);

    res.status(200).json({
      uri: `at://${communityDid}/${PROPOSAL_COLLECTION}/${rkey}`,
      rkey,
      ...record,
      ...objections,
    });
  } catch (error) {
    console.error('Error in getProposal:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to get proposal' });
  }
}

/**
 * Countable objections standing against a proposal, and the threshold they must
 * reach to hold its application.
 *
 * Reads the objectors' signed records rather than the proposal's cache, because
 * the cache is only written once the threshold is met — which is exactly the
 * state this exists to make visible. Returns nothing for a proposal that is not
 * awaiting application, so the response shape is unchanged for every other
 * proposal.
 */
async function pendingObjectionStatus(
  communityDid: string,
  proposalRkey: string,
  proposal: any,
): Promise<Record<string, unknown>> {
  try {
    const objections = await countableObjections({ communityDid, proposalRkey, proposal });
    if (objections.length === 0) return {};
    const settings = await communitySettingsRecord(communityDid);
    return {
      objectionCount: objections.length,
      objectionThreshold: objectionThreshold(settings),
    };
  } catch (err) {
    // A read of the proposal must not fail because this extra detail could not
    // be gathered.
    console.error('[governance] could not count pending objections:', err);
    return {};
  }
}
