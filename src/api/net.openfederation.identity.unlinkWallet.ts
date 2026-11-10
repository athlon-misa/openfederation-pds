import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireApprovedUser } from '../auth/guards.js';
import { auditLog } from '../db/audit.js';
import { unlinkWallet } from '../identity/wallet-link.js';
import { query } from '../db/client.js';

export default async function unlinkWalletHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireApprovedUser(req, res)) return;

    const { label } = req.body;

    if (!label || typeof label !== 'string') {
      res.status(400).json({
        error: 'InvalidRequest',
        message: 'Missing required field: label',
      });
      return;
    }

    // A custodial wallet's key exists only on this server, filed under the
    // link. Removing the link strands it: signing and export both look the
    // wallet up by link, and linking it again needs a signature only that key
    // can make. So the key has to leave first (upgrade the wallet's custody
    // tier, which hands it to the user), and then the wallet can be unlinked.
    const link = await query<{ custody_tier: string | null }>(
      'SELECT custody_tier FROM wallet_links WHERE user_did = $1 AND label = $2',
      [req.auth!.did, label],
    );
    if (link.rows[0]?.custody_tier === 'custodial') {
      res.status(409).json({
        error: 'CustodialWallet',
        message: 'This wallet\'s key is held only by this server. Take custody of it first (upgrade its custody tier), then unlink it.',
      });
      return;
    }

    const deleted = await unlinkWallet(req.auth!.did, label);

    if (!deleted) {
      res.status(404).json({
        error: 'NotFound',
        message: 'No wallet link found with that label',
      });
      return;
    }

    await auditLog('identity.unlinkWallet', req.auth!.userId, req.auth!.did, { label });

    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error in unlinkWallet:', error);
    res.status(500).json({
      error: 'InternalServerError',
      message: 'Failed to unlink wallet',
    });
  }
}
