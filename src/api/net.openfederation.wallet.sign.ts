import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireApprovedUser } from '../auth/guards.js';
import { auditLog } from '../db/audit.js';
import {
  signWithCustodialKey,
  hasActiveConsent,
  getWalletTier,
  isWalletChain,
  normalizeDappOrigin,
} from '../wallet/index.js';

/**
 * POST net.openfederation.wallet.sign
 *
 * Tier 1 only. Requires:
 *   - the authenticated user owns the wallet at `wallet_links.custody_tier = 'custodial'`
 *   - an active, unexpired consent grant from the user to the requesting dApp origin
 *     covering this wallet (see `grantConsent`)
 *
 * The request must carry the dApp's origin in `dappOrigin` (body) or the
 * `X-dApp-Origin` header; the body field takes precedence. Message is signed
 * with the stored private key, which is decrypted in-memory only for the
 * duration of this call.
 *
 * Note: For Tier 2 or Tier 3 wallets this endpoint refuses — clients must sign
 * locally (Tier 2) or in their own wallet software (Tier 3).
 */
export default async function walletSign(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireApprovedUser(req, res)) return;

    const { chain, walletAddress, message, dappOrigin } = req.body ?? {};
    const rawOrigin = dappOrigin ?? req.headers['x-dapp-origin'] ?? req.headers['x-dApp-origin'];

    if (!chain || !isWalletChain(chain)) {
      res.status(400).json({ error: 'UnsupportedChain', message: 'chain must be "ethereum" or "solana"' });
      return;
    }
    if (!walletAddress || typeof walletAddress !== 'string') {
      res.status(400).json({ error: 'InvalidRequest', message: 'walletAddress is required' });
      return;
    }
    if (!message || typeof message !== 'string') {
      res.status(400).json({ error: 'InvalidRequest', message: 'message is required' });
      return;
    }
    if (!rawOrigin || typeof rawOrigin !== 'string') {
      res.status(400).json({
        error: 'InvalidRequest',
        message: 'dappOrigin is required (body field or X-dApp-Origin header)',
      });
      return;
    }

    // Bound the message size to avoid pathological signing costs.
    if (message.length > 4096) {
      res.status(400).json({ error: 'InvalidRequest', message: 'message exceeds 4096 characters' });
      return;
    }

    let origin: string;
    try {
      origin = normalizeDappOrigin(rawOrigin);
    } catch (err) {
      res.status(400).json({ error: 'InvalidRequest', message: (err as Error).message });
      return;
    }

    const userDid = req.auth!.did;
    const userId = req.auth!.userId;
    const normalizedAddress = chain === 'ethereum' ? walletAddress.toLowerCase() : walletAddress;

    // 1. Wallet must exist, belong to this user, and be Tier 1.
    const tierInfo = await getWalletTier(userDid, chain, normalizedAddress);
    if (!tierInfo) {
      res.status(404).json({ error: 'WalletNotFound', message: 'No such wallet for this DID' });
      return;
    }
    if (tierInfo.status !== 'active') {
      res.status(409).json({
        error: 'WalletInactive',
        message: `Wallet is ${tierInfo.status} and cannot be signed with`,
      });
      return;
    }
    if (tierInfo.tier !== 'custodial') {
      res.status(409).json({
        error: 'UnsupportedTier',
        message:
          tierInfo.tier === 'user_encrypted'
            ? 'Tier 2 wallets must sign client-side via the SDK (unlock + signMessage)'
            : 'Tier 3 wallets are self-custodial — use your own wallet software to sign',
      });
      return;
    }

    // 2. Consent must exist for this dApp + wallet combination.
    const consented = await hasActiveConsent({
      userDid,
      dappOrigin: origin,
      chain,
      walletAddress: normalizedAddress,
    });
    if (!consented) {
      res.status(403).json({
        error: 'ConsentRequired',
        message: 'No active consent grants this dApp permission to sign with this wallet',
      });
      return;
    }

    // 3. Sign.
    const signature = await signWithCustodialKey({
      userDid,
      chain,
      walletAddress: normalizedAddress,
      message,
    });
    if (!signature) {
      res.status(500).json({ error: 'SigningFailed', message: 'Custodial key material is missing' });
      return;
    }

    await auditLog('wallet.sign', userId, userDid, {
      chain,
      walletAddress: normalizedAddress,
      dappOrigin: origin,
      messageLength: message.length,
    });

    res.status(200).json({
      chain,
      walletAddress: normalizedAddress,
      signature,
      dappOrigin: origin,
    });
  } catch (err) {
    console.error('Error in walletSign:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'InternalServerError', message: 'Failed to sign' });
    }
  }
}
