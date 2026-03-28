import { Response } from 'express';
import type { AuthRequest, AuthContext } from '../auth/types.js';
import { requireAuth, requireCommunityPermission } from '../auth/guards.js';
import { RepoEngine } from '../repo/repo-engine.js';
import { getKeypairForDid } from '../repo/keypair-utils.js';
import { enforceGovernance, isCommunityDid } from '../governance/enforcement.js';
import { validateOracleKey } from '../auth/oracle-guard.js';
import type { OracleContext } from '../auth/oracle-guard.js';
import { auditLog } from '../db/audit.js';

/**
 * com.atproto.repo.putRecord
 *
 * Create or update a record in a repository. Requires auth.
 * The caller must have write access to the repo (owner or PDS admin).
 */
export default async function putRecord(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireAuth(req, res)) {
      return;
    }

    const { repo, collection, rkey, record } = req.body;

    if (!repo || !collection || !rkey || !record) {
      res.status(400).json({
        error: 'InvalidRequest',
        message: 'Missing required fields: repo, collection, rkey, record',
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

    // Authorization: caller must have write access to this repo.
    if (repo !== req.auth!.did) {
      const hasPermission = await requireCommunityPermission(
        req as AuthRequest & { auth: AuthContext },
        res, repo, 'community.member.write'
      );
      if (!hasPermission) return;
    }

    // Check for Oracle authentication
    let oracleContext: OracleContext | null = null;
    if (req.headers['x-oracle-key']) {
      oracleContext = await validateOracleKey(req);
    }

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
    }

    const engine = new RepoEngine(repo);
    const keypair = await getKeypairForDid(repo);

    const result = await engine.putRecord(keypair, collection, rkey, record);

    // Log governance proof if Oracle-submitted
    if (oracleContext && req.body.governanceProof) {
      await auditLog('oracle.proofApplied', oracleContext.credentialId, repo, {
        collection, rkey, action: 'write',
        proof: req.body.governanceProof,
      });
    }

    res.status(200).json({
      uri: result.uri,
      cid: result.cid,
    });
  } catch (error) {
    console.error('Error in putRecord:', error);
    res.status(500).json({
      error: 'InternalServerError',
      message: 'Failed to write record',
    });
  }
}
