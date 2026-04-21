import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { query } from '../db/client.js';

/**
 * GET net.openfederation.identity.listWalletsPublic
 *
 * Public counterpart of the authenticated listWalletLinks — returns every
 * active wallet link for a given DID, suitable for dApps building out a
 * user's full on-chain identity surface. Only exposes public fields (chain,
 * address, label, linked_at, custody tier, primary flag) — never anything
 * about consent grants, custody keys, or internals.
 *
 * Unauthenticated.
 */
export default async function listWalletsPublic(req: AuthRequest, res: Response): Promise<void> {
  try {
    const did = (typeof req.query.did === 'string' ? req.query.did : '').trim();
    if (!did || !did.startsWith('did:')) {
      res.status(400).json({ error: 'InvalidRequest', message: 'did is required' });
      return;
    }

    const result = await query<{
      chain: string;
      wallet_address: string;
      label: string | null;
      linked_at: Date;
      custody_tier: string;
      is_primary: boolean;
    }>(
      `SELECT chain, wallet_address, label, linked_at, custody_tier, is_primary
       FROM wallet_links
       WHERE user_did = $1 AND custody_status = 'active'
       ORDER BY is_primary DESC, linked_at DESC`,
      [did]
    );

    const handleRes = await query<{ handle: string }>(
      'SELECT handle FROM users WHERE did = $1',
      [did]
    );
    const handle = handleRes.rows[0]?.handle ?? null;

    const wallets = result.rows.map((r) => ({
      chain: r.chain,
      walletAddress: r.wallet_address,
      label: r.label,
      linkedAt: r.linked_at instanceof Date ? r.linked_at.toISOString() : r.linked_at,
      custodyTier: r.custody_tier,
      isPrimary: r.is_primary,
    }));

    res.status(200).json({ did, handle, wallets });
  } catch (err) {
    console.error('Error in listWalletsPublic:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'InternalServerError', message: 'Failed to list wallets' });
    }
  }
}
