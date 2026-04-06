import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireApprovedUser } from '../auth/guards.js';
import { auditLog } from '../db/audit.js';
import { isSupportedChain, verifyAndLink } from '../identity/wallet-link.js';

export default async function linkWallet(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireApprovedUser(req, res)) return;

    const { chain, walletAddress, challenge, signature, label } = req.body;

    if (!chain || !walletAddress || !challenge || !signature) {
      res.status(400).json({
        error: 'InvalidRequest',
        message: 'Missing required fields: chain, walletAddress, challenge, signature',
      });
      return;
    }

    if (!isSupportedChain(chain)) {
      res.status(400).json({
        error: 'UnsupportedChain',
        message: `Unsupported chain: ${chain}. Supported chains: ethereum, solana`,
      });
      return;
    }

    if (label && (typeof label !== 'string' || label.length > 64)) {
      res.status(400).json({
        error: 'InvalidRequest',
        message: 'Label must be a string of at most 64 characters',
      });
      return;
    }

    const result = await verifyAndLink(
      req.auth!.did,
      chain,
      walletAddress,
      challenge,
      signature,
      label
    );

    if (!result.success) {
      res.status(400).json({
        error: 'LinkFailed',
        message: result.error,
      });
      return;
    }

    await auditLog('identity.linkWallet', req.auth!.userId, req.auth!.did, {
      chain,
      walletAddress,
      label: label || null,
    });

    res.status(200).json({
      success: true,
      chain,
      walletAddress,
      label: label || null,
    });
  } catch (error) {
    console.error('Error in linkWallet:', error);
    res.status(500).json({
      error: 'InternalServerError',
      message: 'Failed to link wallet',
    });
  }
}
