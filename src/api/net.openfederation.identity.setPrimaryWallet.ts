import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireApprovedUser } from '../auth/guards.js';
import { withTransaction } from '../db/client.js';
import { auditLog } from '../db/audit.js';
import { isWalletChain } from '../wallet/index.js';
import { XrpcError, renderXrpcError } from '../xrpc/errors.js';

const NSID = 'net.openfederation.identity.setPrimaryWallet';

/**
 * POST net.openfederation.identity.setPrimaryWallet
 *
 * Mark one of the caller's active wallets as the primary for its chain.
 * Atomically clears any existing primary on the same (user, chain) before
 * setting the new one, so the partial unique index never conflicts.
 */
export default async function setPrimaryWallet(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireApprovedUser(req, res)) return;

    const { chain, walletAddress } = req.body ?? {};

    if (!chain || !isWalletChain(chain)) {
      res.status(400).json({ error: 'UnsupportedChain', message: 'chain must be "ethereum" or "solana"' });
      return;
    }
    if (!walletAddress || typeof walletAddress !== 'string') {
      res.status(400).json({ error: 'InvalidRequest', message: 'walletAddress is required' });
      return;
    }

    const userDid = req.auth!.did;
    const addr = chain === 'ethereum' ? walletAddress.toLowerCase() : walletAddress;

    await withTransaction(async (client) => {
      const owned = await client.query<{ id: string; custody_status: string }>(
        `SELECT id, custody_status FROM wallet_links
         WHERE user_did = $1 AND chain = $2 AND wallet_address = $3
         FOR UPDATE`,
        [userDid, chain, addr]
      );
      if (owned.rows.length === 0) {
        throw new XrpcError(NSID, 'WalletNotFound', 404, 'No such wallet for this DID');
      }
      if (owned.rows[0].custody_status !== 'active') {
        throw new XrpcError(
          NSID,
          'WalletInactive',
          409,
          `Wallet is ${owned.rows[0].custody_status}; only active wallets can be primary`,
        );
      }

      // Clear any existing primary on (user, chain), then set the new one.
      await client.query(
        `UPDATE wallet_links
         SET is_primary = FALSE
         WHERE user_did = $1 AND chain = $2 AND is_primary = TRUE`,
        [userDid, chain]
      );
      await client.query(
        `UPDATE wallet_links
         SET is_primary = TRUE
         WHERE id = $1`,
        [owned.rows[0].id]
      );
    });

    await auditLog('identity.setPrimaryWallet', req.auth!.userId, userDid, {
      chain,
      walletAddress: addr,
    });

    res.status(200).json({ chain, walletAddress: addr, isPrimary: true });
  } catch (err) {
    if (res.headersSent) return;
    renderXrpcError(NSID, res, err);
  }
}
