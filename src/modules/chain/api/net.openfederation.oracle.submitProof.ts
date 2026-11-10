import { Response } from 'express';
import type { AuthRequest } from '../../../auth/types.js';
import { requireOracleAuth } from '../oracle-auth.js';
import { resolveAttestor } from '../../../governance/attestor.js';
import { getCachedVerification, cacheVerification } from '../proof-cache.js';
import { auditLog } from '../../../db/audit.js';
import type { GovernanceProof } from '../../../governance/attestor.js';
import { config } from '../../../config.js';
import { query } from '../../../db/client.js';

export default async function submitProof(req: AuthRequest, res: Response): Promise<void> {
  try {
    const oracle = requireOracleAuth(req, res);
    if (!oracle) return;

    // 2. Validate input
    const { chainId, transactionHash, blockNumber, contractAddress, expectedOutcome } = req.body || {};

    if (!chainId || typeof chainId !== 'string') {
      res.status(400).json({ error: 'InvalidRequest', message: 'chainId is required.' });
      return;
    }
    if (!transactionHash || typeof transactionHash !== 'string') {
      res.status(400).json({ error: 'InvalidRequest', message: 'transactionHash is required.' });
      return;
    }

    // Input length bounds (DB columns are VARCHAR(64) and VARCHAR(255))
    if (chainId.length > 64) {
      res.status(400).json({ error: 'InvalidRequest', message: 'chainId exceeds maximum length (64).' });
      return;
    }
    if (transactionHash.length > 255) {
      res.status(400).json({ error: 'InvalidRequest', message: 'transactionHash exceeds maximum length (255).' });
      return;
    }
    if (blockNumber !== undefined) {
      const bn = Number(blockNumber);
      if (!Number.isInteger(bn) || bn < 0) {
        res.status(400).json({ error: 'InvalidRequest', message: 'blockNumber must be a non-negative integer.' });
        return;
      }
    }

    // The community decides which contract its governance runs on; the oracle
    // only reports a transaction. Without that setting there is nothing to
    // verify the transaction *against*: any successful transaction on the
    // chain would pass. So a proof is checked against the community's own
    // contract and chain, and an oracle that names a different one is refused.
    const settings = await query<{ config: { contractAddress?: unknown; chainId?: unknown } | null }>(
      `SELECT record->'governanceConfig' AS config FROM records_index
       WHERE community_did = $1 AND collection = 'net.openfederation.community.settings' AND rkey = 'self'`,
      [oracle.communityDid],
    );
    const configured = settings.rows[0]?.config ?? null;
    const communityContract = typeof configured?.contractAddress === 'string' ? configured.contractAddress : null;
    const communityChain = typeof configured?.chainId === 'string' && configured.chainId ? configured.chainId : null;
    const refuse = async (reason: string) => {
      await auditLog('oracle.proofApplied', oracle.credentialId, oracle.communityDid, {
        chainId, transactionHash, verified: false, verificationMethod: 'none', reason,
      });
      res.json({ verified: false, error: reason, cached: false, verificationMethod: 'none' });
    };
    if (!communityContract) {
      await refuse('The community has not configured its governance contract (governanceConfig.contractAddress)');
      return;
    }
    if (communityChain && communityChain !== chainId) {
      await refuse(`The community's governance runs on ${communityChain}, not ${chainId}`);
      return;
    }
    if (contractAddress && String(contractAddress).toLowerCase() !== communityContract.toLowerCase()) {
      await refuse('The proof names a contract other than the community\'s governance contract');
      return;
    }

    // 3. Build the complete verification constraints before checking cache.
    const proof: GovernanceProof = {
      chainId,
      transactionHash,
      blockNumber: blockNumber !== undefined ? Number(blockNumber) : undefined,
      contractAddress: communityContract,
      expectedOutcome: expectedOutcome || undefined,
    };
    const cached = await getCachedVerification(oracle.communityDid, proof);
    if (cached) {
      res.json({
        verified: cached.verified,
        error: cached.error ?? undefined,
        blockTimestamp: cached.blockTimestamp ?? undefined,
        confirmations: cached.confirmations ?? undefined,
        cached: true,
        verificationMethod: 'cache',
      });
      return;
    }

    // 4. Find attestor
    const adapter = resolveAttestor(chainId);

    if (!adapter && !config.chains.trustUnverifiedProofs) {
      // No adapter means this server cannot look at the chain, so it cannot
      // say the proof is good. It says so. (Not cached, for the same reason
      // as below: an adapter registered later should get to verify it.)
      const reason = `No verifier is configured for chain ${chainId}`;
      await auditLog('oracle.proofApplied', oracle.credentialId, oracle.communityDid, {
        chainId,
        transactionHash,
        verified: false,
        verificationMethod: 'none',
        reason,
        expectedOutcome,
      });
      res.json({ verified: false, error: reason, cached: false, verificationMethod: 'none' });
      return;
    }

    if (!adapter) {
      // The operator has opted in (ORACLE_TRUST_UNVERIFIED_PROOFS): trust the
      // Oracle, and record that nothing was verified on-chain.
      // NOTE: Do NOT cache oracle-trust results — if an adapter is registered later,
      // the same proof should be verified on-chain rather than served from a stale cache.
      await auditLog('oracle.proofApplied', oracle.credentialId, oracle.communityDid, {
        chainId,
        transactionHash,
        verificationMethod: 'oracle-trust',
        reason: `No adapter registered for chain ${chainId}`,
        expectedOutcome,
      });

      res.json({
        verified: true,
        cached: false,
        verificationMethod: 'oracle-trust',
      });
      return;
    }

    // 6. Verify on-chain
    const result = await adapter.verifyProof(proof);

    // 7. Cache result
    await cacheVerification(oracle.communityDid, proof, result, oracle.credentialId);

    // 8. Audit log
    await auditLog('oracle.proofApplied', oracle.credentialId, oracle.communityDid, {
      chainId,
      transactionHash,
      verified: result.verified,
      verificationMethod: 'on-chain',
      adapterName: adapter.name,
      error: result.error,
      blockTimestamp: result.blockTimestamp,
      confirmations: result.confirmations,
      expectedOutcome,
    });

    // 9. Respond
    res.json({
      verified: result.verified,
      error: result.error ?? undefined,
      blockTimestamp: result.blockTimestamp ?? undefined,
      confirmations: result.confirmations ?? undefined,
      cached: false,
      verificationMethod: 'on-chain',
    });
  } catch (error) {
    console.error('Error in submitProof:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to verify proof.' });
  }
}
