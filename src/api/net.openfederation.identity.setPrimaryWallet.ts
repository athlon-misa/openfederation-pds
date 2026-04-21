import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireApprovedUser } from '../auth/guards.js';
import { getClient } from '../db/client.js';
import { auditLog } from '../db/audit.js';
import { isWalletChain } from '../wallet/index.js';

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

    const client = await getClient();
    try {
      await client.query('BEGIN');

      const owned = await client.query<{ id: string; custody_status: string }>(
        `SELECT id, custody_status FROM wallet_links
         WHERE user_did = $1 AND chain = $2 AND wallet_address = $3
         FOR UPDATE`,
        [userDid, chain, addr]
      );
      if (owned.rows.length === 0) {
        await client.query('ROLLBACK');
        res.status(404).json({ error: 'WalletNotFound', message: 'No such wallet for this DID' });
        return;
      }
      if (owned.rows[0].custody_status !== 'active') {
        await client.query('ROLLBACK');
        res.status(409).json({
          error: 'WalletInactive',
          message: `Wallet is ${owned.rows[0].custody_status}; only active wallets can be primary`,
        });
        return;
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

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    await auditLog('identity.setPrimaryWallet', req.auth!.userId, userDid, {
      chain,
      walletAddress: addr,
    });

    res.status(200).json({ chain, walletAddress: addr, isPrimary: true });
  } catch (err) {
    console.error('Error in setPrimaryWallet:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'InternalServerError', message: 'Failed to set primary wallet' });
    }
  }
}
