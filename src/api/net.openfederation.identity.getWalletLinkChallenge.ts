import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireApprovedUser } from '../auth/guards.js';
import { isSupportedChain, createChallenge } from '../identity/wallet-link.js';

export default async function getWalletLinkChallenge(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireApprovedUser(req, res)) return;

    const chain = req.query.chain as string;
    const walletAddress = req.query.walletAddress as string;

    if (!chain || !walletAddress) {
      res.status(400).json({
        error: 'InvalidRequest',
        message: 'Missing required parameters: chain, walletAddress',
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

    const result = await createChallenge(req.auth!.did, chain, walletAddress);

    res.status(200).json(result);
  } catch (error) {
    console.error('Error in getWalletLinkChallenge:', error);
    res.status(500).json({
      error: 'InternalServerError',
      message: 'Failed to generate wallet link challenge',
    });
  }
}
