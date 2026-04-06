import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { isSupportedChain, resolveWallet } from '../identity/wallet-link.js';

export default async function resolveWalletHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
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

    const result = await resolveWallet(chain, walletAddress);

    if (!result) {
      res.status(404).json({
        error: 'WalletNotFound',
        message: 'No identity linked to this wallet address',
      });
      return;
    }

    res.status(200).json(result);
  } catch (error) {
    console.error('Error in resolveWallet:', error);
    res.status(500).json({
      error: 'InternalServerError',
      message: 'Failed to resolve wallet',
    });
  }
}
