import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireApprovedUser } from '../auth/guards.js';
import { auditLog } from '../db/audit.js';
import { unlinkWallet } from '../identity/wallet-link.js';

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
