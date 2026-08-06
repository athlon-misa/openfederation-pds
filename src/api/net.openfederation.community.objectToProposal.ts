import { Response } from 'express';
import type { AuthRequest, AuthContext } from '../auth/types.js';
import { requireAuth, requireCommunityPermission } from '../auth/guards.js';
import { RepoEngine } from '../repo/repo-engine.js';
import { getKeypairForDid } from '../repo/keypair-utils.js';
import { auditLog } from '../db/audit.js';
import { query, withAdvisoryLock } from '../db/client.js';
import { putProposalRecord } from '../governance/proposal-resolution.js';
import { PROPOSAL_COLLECTION } from '../governance/decision-rules.js';
import { canRecordObjection, writeObjectionRecord } from '../governance/objection-records.js';
import {
  OBJECTED_STATUS,
  OVERRIDE_STATUS,
  heldProposalState,
  PENDING_STATUS,
  applyDueProposals,
  closeExpiredOverrides,
  communitySettingsRecord,
  countableObjections,
  objectionThreshold,
  proposalLockKey,
} from '../governance/timelock.js';

const MAX_REASON_LENGTH = 2000;

/**
 * Contest the application of a decision inside its timelock window.
 *
 * Eligibility is not a new notion: it is the permission that gated the vote
 * (`community.governance.write`), so exactly the members who could have voted
 * against the proposal can object to the application of it. The objection
 * itself is a record in the objector's own repo, signed with their key —
 * visible through `com.atproto.repo.listRecords` like any other record, and
 * checkable by a third party without trusting this PDS.
 */
export default async function objectToProposal(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireAuth(req, res)) return;

    const { communityDid, proposalRkey, reason } = req.body;

    if (!communityDid || !proposalRkey) {
      res.status(400).json({
        error: 'InvalidRequest',
        message: 'Missing required fields: communityDid, proposalRkey',
      });
      return;
    }
    if (reason !== undefined && (typeof reason !== 'string' || reason.length > MAX_REASON_LENGTH)) {
      res.status(400).json({
        error: 'InvalidRequest',
        message: `reason must be a string of at most ${MAX_REASON_LENGTH} characters`,
      });
      return;
    }

    const hasPermission = await requireCommunityPermission(
      req as AuthRequest & { auth: AuthContext }, res, communityDid, 'community.governance.write'
    );
    if (!hasPermission) return;

    // Any window that has already elapsed is applied first, outside the lock
    // this handler takes below. A late objection must find the change applied,
    // not race it.
    await applyDueProposals(communityDid);
    await closeExpiredOverrides(communityDid);

    return await withAdvisoryLock(proposalLockKey(communityDid, proposalRkey), async () => {
      const result = await query<{ record: any; cid: string }>(
        `SELECT record, cid FROM records_index
         WHERE community_did = $1 AND collection = $2 AND rkey = $3`,
        [communityDid, PROPOSAL_COLLECTION, proposalRkey],
      );

      if (result.rows.length === 0) {
        res.status(404).json({ error: 'ProposalNotFound', message: 'No proposal found with the given rkey' });
        return;
      }

      const proposal = result.rows[0].record;
      const proposalCid = result.rows[0].cid;

      if (proposal.status === OBJECTED_STATUS || proposal.status === OVERRIDE_STATUS) {
        // Already held. Another objection changes nothing about the hold, and
        // there is no window left to object into. A proposal in its override
        // round is answered by voting in that round, not by objecting again —
        // one round is the whole point (#199).
        res.status(400).json({
          error: 'ObjectionWindowClosed',
          message: proposal.status === OVERRIDE_STATUS
            ? 'This proposal is held and in its override round; vote in that round rather than objecting again'
            : 'This proposal is already held by an objection',
        });
        return;
      }
      if (proposal.status !== PENDING_STATUS) {
        res.status(400).json({
          error: 'ProposalNotPending',
          message: 'Only a proposal awaiting application can be objected to',
        });
        return;
      }

      const applyAt = typeof proposal.applyAt === 'string' ? proposal.applyAt : null;
      const decision = proposal.decision;
      if (!applyAt || !decision?.uri || !decision?.cid) {
        res.status(400).json({
          error: 'ProposalNotPending',
          message: 'This proposal has no decision and contest window to object to',
        });
        return;
      }
      if (new Date().toISOString() >= applyAt) {
        // Reached only if the sweep above could not apply the change; the
        // window is over either way, and a late objection does not hold it.
        res.status(400).json({
          error: 'ObjectionWindowClosed',
          message: 'The objection window for this proposal has closed',
        });
        return;
      }

      const objectorDid = req.auth!.did;
      // The cache names objections only once a hold has been recorded, which
      // under a threshold above 1 happens after several. The signed records are
      // what actually count, so they decide whether this objector has already
      // spoken — otherwise a member below the threshold could object repeatedly
      // and mint a record per attempt, none of which would count twice anyway.
      const standing = await countableObjections({ communityDid, proposalRkey, proposal });
      const already = standing.some(o => o.objector === objectorDid)
        || (proposal.objections ?? []).some((o: any) => o?.objector === objectorDid);
      if (already) {
        res.status(409).json({ error: 'AlreadyObjected', message: 'You have already objected to this proposal' });
        return;
      }

      // An objector with no repo cannot sign the record, and an unsigned
      // objection is the operator's assertion rather than the member's act.
      // Same determination `voteOnProposal` makes before counting a vote.
      let canRecord: boolean;
      try {
        canRecord = await canRecordObjection(objectorDid);
      } catch (error) {
        console.error(`[governance] repo check failed for objector ${objectorDid}:`, error);
        res.status(500).json({
          error: 'InternalServerError',
          message: 'Could not determine whether this objection can be recorded; please retry',
        });
        return;
      }
      if (!canRecord) {
        res.status(400).json({
          error: 'ObjectionNotRecordable',
          message: 'This account has no repository, so its objection cannot be recorded as verifiable evidence',
        });
        return;
      }

      // The record is the objection. If it cannot be written there is nothing
      // to hold the change with, so the failure is raised rather than swallowed.
      let objection;
      try {
        objection = await writeObjectionRecord({
          objectorDid,
          communityDid,
          proposalRkey,
          proposalCid,
          decision: { uri: decision.uri, cid: decision.cid },
          ...(reason ? { reason } : {}),
        });
      } catch (error) {
        console.error(`[governance] failed to write objection record for ${objectorDid}:`, error);
        res.status(500).json({
          error: 'InternalServerError',
          message: 'The objection could not be recorded and has not been registered',
        });
        return;
      }

      // Recomputed from the signed records rather than appended to the cache,
      // so the proposal's `objections` array can only ever name objections that
      // actually exist and actually count.
      const objections = await countableObjections({ communityDid, proposalRkey, proposal });
      const settings = await communitySettingsRecord(communityDid);
      const threshold = objectionThreshold(settings);
      const held = objections.length >= threshold;

      // Only a hold changes the proposal. Rewriting it when the threshold is
      // not reached would mint a signed MST commit for a proposal whose state
      // has not changed.
      let heldState: Record<string, unknown> | null = null;
      if (held) {
        const engine = new RepoEngine(communityDid);
        const keypair = await getKeypairForDid(communityDid);
        heldState = await heldProposalState({
          communityDid,
          proposal,
          settings,
          objections,
          heldAt: new Date().toISOString(),
        });
        await putProposalRecord(engine, keypair, communityDid, proposalRkey, heldState);
        if (heldState.status === OVERRIDE_STATUS) {
          await auditLog('community.proposal.overrideOpened', req.auth!.userId, communityDid, {
            rkey: proposalRkey,
            overrideQuorum: heldState.overrideQuorum,
            overrideExpiresAt: heldState.overrideExpiresAt,
            overrideElectorate: heldState.overrideElectorate,
            objectionCount: objections.length,
          });
        }
      }

      await auditLog('community.proposal.objection', req.auth!.userId, communityDid, {
        rkey: proposalRkey,
        objector: objectorDid,
        objectionUri: objection.uri,
        objectionCid: objection.cid,
        decisionUri: decision.uri,
        decisionCid: decision.cid,
        applyAt,
        objectionThreshold: threshold,
        objectionCount: objections.length,
        held,
        ...(heldState ? { status: heldState.status } : {}),
      });

      res.status(200).json({
        recorded: true,
        status: heldState ? heldState.status : proposal.status,
        objectionCount: objections.length,
        objectionThreshold: threshold,
        objection: { uri: objection.uri, cid: objection.cid, rkey: objection.rkey },
        // The round the hold opened, so the objector's own client can say what
        // happens next rather than reporting a dead end.
        ...(heldState?.status === OVERRIDE_STATUS
          ? {
            overrideQuorum: heldState.overrideQuorum,
            overrideExpiresAt: heldState.overrideExpiresAt,
          }
          : {}),
      });
    });
  } catch (error) {
    console.error('Error in objectToProposal:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to record objection' });
  }
}
