import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireApprovedUser } from '../auth/guards.js';
import { auditLog } from '../db/audit.js';
import { revokeConsent, isWalletChain } from '../wallet/index.js';

/**
 * POST net.openfederation.wallet.revokeConsent
 *
 * Revoke one consent by id, or a set of consents by (dappOrigin, chain?, walletAddress?).
 * Returns the number revoked.
 */
export default async function walletRevokeConsent(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireApprovedUser(req, res)) return;

    const { id, dappOrigin, chain, walletAddress } = req.body ?? {};

    if (!id && !dappOrigin) {
      res.status(400).json({
        error: 'InvalidRequest',
        message: 'Either id or dappOrigin must be provided',
      });
      return;
    }

    if (chain !== undefined && !isWalletChain(chain)) {
      res.status(400).json({ error: 'UnsupportedChain', message: 'chain must be "ethereum" or "solana" if provided' });
      return;
    }

    const normalizedAddress = walletAddress
      ? (chain === 'ethereum' ? String(walletAddress).toLowerCase() : String(walletAddress))
      : undefined;

    let revokedCount: number;
    try {
      revokedCount = await revokeConsent({
        userDid: req.auth!.did,
        id: typeof id === 'string' ? id : undefined,
        dappOrigin: typeof dappOrigin === 'string' ? dappOrigin : undefined,
        chain: chain as any,
        walletAddress: normalizedAddress,
      });
    } catch (err) {
      res.status(400).json({ error: 'InvalidRequest', message: (err as Error).message });
      return;
    }

    await auditLog('wallet.consent.revoke', req.auth!.userId, req.auth!.did, {
      id: typeof id === 'string' ? id : null,
      dappOrigin: typeof dappOrigin === 'string' ? dappOrigin : null,
      chain: chain ?? null,
      walletAddress: normalizedAddress ?? null,
      revokedCount,
    });

    res.status(200).json({ revoked: revokedCount });
  } catch (err) {
    console.error('Error in walletRevokeConsent:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'InternalServerError', message: 'Failed to revoke consent' });
    }
  }
}
