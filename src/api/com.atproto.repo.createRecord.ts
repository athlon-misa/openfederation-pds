import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireAuth } from '../auth/guards.js';
import { RepoEngine } from '../repo/repo-engine.js';
import { getKeypairForDid } from '../repo/keypair-utils.js';
import { authorizeCollectionMutation } from '../repo/collection-policy.js';
import { enforceGovernance, isCommunityDid } from '../governance/enforcement.js';
import {
  auditOracleMutation,
  prepareOracleMutationAudit,
  type OracleMutationAudit,
} from '../governance/oracle-mutation-audit.js';
import { FORUM_THREAD, FORUM_POST, CALENDAR_EVENT, CALENDAR_RSVP } from '../forum/forum-index.js';
import { renderXrpcError } from '../xrpc/errors.js';

const NSID = 'com.atproto.repo.createRecord';

/**
 * com.atproto.repo.createRecord
 *
 * Create a new record in a repository with an auto-generated rkey (TID).
 * Requires auth and write permission on the target repo.
 */
export default async function createRecord(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireAuth(req, res)) {
      return;
    }

    const { repo, collection, record, rkey } = req.body;

    if (!repo || !collection || !record) {
      res.status(400).json({
        error: 'InvalidRequest',
        message: 'Missing required fields: repo, collection, record',
      });
      return;
    }

    if (typeof repo !== 'string' || !repo.startsWith('did:')) {
      res.status(400).json({
        error: 'InvalidRequest',
        message: 'repo must be a valid DID',
      });
      return;
    }

    const DEDICATED = [FORUM_THREAD, FORUM_POST, CALENDAR_EVENT, CALENDAR_RSVP];
    if (DEDICATED.includes(collection)) {
      res.status(400).json({
        error: 'UseDedicatedEndpoint',
        message: `Records in "${collection}" must be written via their net.openfederation.forum.* / net.openfederation.calendar.* endpoint.`,
      });
      return;
    }

    await authorizeCollectionMutation({
      actor: req.auth!,
      repo,
      collection,
      operation: 'create',
    });

    const oracleContext = req.oracleAuth ?? null;
    let oracleAudit: OracleMutationAudit | null = null;

    // Governance enforcement for community repos
    if (await isCommunityDid(repo)) {
      const governance = await enforceGovernance(repo, collection, 'write', oracleContext);
      if (!governance.allowed) {
        res.status(403).json({
          error: 'GovernanceDenied',
          message: governance.reason || 'Write blocked by governance policy',
          ...(governance.requiresProposal ? { requiresProposal: true } : {}),
        });
        return;
      }
      oracleAudit = prepareOracleMutationAudit({
        governance,
        oracle: oracleContext,
        governanceProof: req.body.governanceProof,
      });
    }

    const engine = new RepoEngine(repo);
    const keypair = await getKeypairForDid(repo);
    const recordKey = rkey || RepoEngine.generateTid();

    const result = await engine.putRecord(keypair, collection, recordKey, record);

    if (oracleAudit) {
      await auditOracleMutation({
        audit: oracleAudit,
        communityDid: repo,
        collection,
        rkey: recordKey,
        action: 'write',
      });
    }

    res.status(200).json({
      uri: result.uri,
      cid: result.cid,
    });
  } catch (error) {
    renderXrpcError(NSID, res, error);
  }
}
