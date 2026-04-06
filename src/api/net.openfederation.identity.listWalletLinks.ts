import type { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireAuth, requireApprovedUser } from '../auth/guards.js';
import { getWalletLinks } from '../identity/wallet-link.js';

export default async function listWalletLinks(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireAuth(req, res)) return;
    if (!(await requireApprovedUser(req, res))) return;

    const links = await getWalletLinks(req.auth!.did);
    res.json({ walletLinks: links });
  } catch (error) {
    console.error('Error listing wallet links:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to list wallet links.' });
  }
}
