import { Request, Response } from 'express';
import { validateOracleKey } from '../auth/oracle-guard.js';
import { getAdapter } from '../governance/chain-adapter.js';
import { getCachedVerification, cacheVerification } from '../governance/proof-cache.js';
import { auditLog } from '../db/audit.js';
import type { GovernanceProof } from '../governance/chain-adapter.js';

export default async function submitProof(req: Request, res: Response): Promise<void> {
  try {
    // 1. Validate Oracle key
    const oracle = await validateOracleKey(req);
    if (!oracle) {
      res.status(401).json({ error: 'AuthRequired', message: 'Valid X-Oracle-Key header required.' });
      return;
    }

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

    // 3. Check cache first
    const cached = await getCachedVerification(chainId, transactionHash);
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

    // 4. Build proof object
    const proof: GovernanceProof = {
      chainId,
      transactionHash,
      blockNumber: blockNumber !== undefined ? Number(blockNumber) : undefined,
      contractAddress: contractAddress || undefined,
      expectedOutcome: expectedOutcome || undefined,
    };

    // 5. Find adapter
    const adapter = getAdapter(chainId);

    if (!adapter) {
      // Graceful fallback: trust the Oracle, log as unverified
      await cacheVerification(oracle.communityDid, proof, { verified: true }, oracle.credentialId);

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
