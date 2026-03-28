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
 * com.atproto.repo.deleteRecord
 *
 * Delete a record from a repository. Requires auth and write permission.
 */
export default async function deleteRecord(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireAuth(req, res)) {
      return;
    }

    const { repo, collection, rkey } = req.body;

    if (!repo || !collection || !rkey) {
      res.status(400).json({
        error: 'InvalidRequest',
        message: 'Missing required fields: repo, collection, rkey',
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
        res, repo, 'community.member.delete'
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
      const governance = await enforceGovernance(repo, collection, 'delete', oracleContext);
      if (!governance.allowed) {
        res.status(403).json({
          error: 'GovernanceDenied',
          message: governance.reason || 'Delete blocked by governance policy',
          ...(governance.requiresProposal ? { requiresProposal: true } : {}),
        });
        return;
      }
    }

    const engine = new RepoEngine(repo);
    const keypair = await getKeypairForDid(repo);

    await engine.deleteRecord(keypair, collection, rkey);

    // Log governance proof if Oracle-submitted
    if (oracleContext && req.body.governanceProof) {
      await auditLog('oracle.proofApplied', oracleContext.credentialId, repo, {
        collection, rkey, action: 'delete',
        proof: req.body.governanceProof,
      });
    }

    res.status(200).json({});
  } catch (error) {
    console.error('Error in deleteRecord:', error);
    res.status(500).json({
      error: 'InternalServerError',
      message: 'Failed to delete record',
    });
  }
}
