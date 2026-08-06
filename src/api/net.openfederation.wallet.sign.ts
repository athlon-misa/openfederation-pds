import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireApprovedUser } from '../auth/guards.js';
import { auditLog } from '../db/audit.js';
import {
  signWithCustodialKey,
  isWalletChain,
  normalizeDappOrigin,
  assertCustodialSigningEligible,
  WalletEligibilityRejection,
  assertDappOriginBinding,
  DappOriginBindingRejection,
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

    // The declared origin decides which consent unlocks the key, so it must be
    // the origin the request actually came from — not merely one the caller
    // asserts. See src/wallet/origin-binding.ts.
    try {
      origin = assertDappOriginBinding(req.headers.origin as string | undefined, origin);
    } catch (err) {
      if (err instanceof DappOriginBindingRejection) {
        await auditLog('wallet.sign.originRejected', req.auth!.userId, req.auth!.did, {
          declaredOrigin: origin,
          requestOrigin: (req.headers.origin as string | undefined) ?? null,
          reason: err.code,
          chain,
          walletAddress,
        });
        res.status(err.status).json({ error: err.code, message: err.message });
        return;
      }
      throw err;
    }

    const userDid = req.auth!.did;
    const userId = req.auth!.userId;
    const normalizedAddress = chain === 'ethereum' ? walletAddress.toLowerCase() : walletAddress;

    try {
      await assertCustodialSigningEligible({
        userDid,
        chain,
        walletAddress: normalizedAddress,
        dappOrigin: origin,
      });
    } catch (err) {
      if (err instanceof WalletEligibilityRejection) {
        res.status(err.status).json({ error: err.code, message: err.message });
        return;
      }
      throw err;
    }

    // Sign.
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
