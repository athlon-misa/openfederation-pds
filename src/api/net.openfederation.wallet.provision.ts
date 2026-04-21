import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireApprovedUser } from '../auth/guards.js';
import { auditLog } from '../db/audit.js';
import {
  generateWallet,
  storeCustodialKey,
  linkCustodialWallet,
  isWalletChain,
} from '../wallet/index.js';

/**
 * POST net.openfederation.wallet.provision
 *
 * Tier 1 only. The PDS generates a fresh keypair for the requested chain,
 * encrypts the private key at rest in `wallet_custody`, and links the public
 * address to the user's DID in `wallet_links` with `custody_tier='custodial'`.
 *
 * The returned address is *the* wallet — the user never sees the private key
 * (that's the whole point of Tier 1). If they later want self-custody, the
 * upgrade path (M2.5) will export the key and mark the row as Tier 3.
 */
export default async function walletProvision(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireApprovedUser(req, res)) return;

    const { chain, label } = req.body ?? {};

    if (!chain || !isWalletChain(chain)) {
      res.status(400).json({
        error: 'UnsupportedChain',
        message: 'chain must be "ethereum" or "solana"',
      });
      return;
    }

    if (label !== undefined) {
      if (typeof label !== 'string' || label.length === 0 || label.length > 64) {
        res.status(400).json({
          error: 'InvalidRequest',
          message: 'label, if provided, must be a 1-64 character string',
        });
        return;
      }
    }

    const userDid = req.auth!.did;
    const userId = req.auth!.userId;

    // 1. Generate fresh key + derive address.
    const generated = generateWallet(chain);

    // 2. Link it to the DID via the server-side custodial-link helper. This
    //    also guards against collisions with wallets already linked to other
    //    DIDs before we bother encrypting the key.
    const linkResult = await linkCustodialWallet({
      userDid,
      chain,
      walletAddress: generated.address,
      privateKey: generated.privateKey,
      label,
    });

    if (!linkResult.success) {
      // Wipe before bailing.
      generated.privateKey.fill(0);
      res.status(409).json({ error: 'ProvisionFailed', message: linkResult.error });
      return;
    }

    // 3. Store the encrypted key. If this fails after the link was created,
    //    we leave the link in place (address is still bound to the DID) and
    //    surface a clear error — the next provision() call will try again.
    try {
      await storeCustodialKey(userDid, chain, generated.address, generated.privateKey);
    } finally {
      generated.privateKey.fill(0);
    }

    await auditLog('wallet.provision', userId, userDid, {
      chain,
      walletAddress: generated.address,
      tier: 'custodial',
      label: label ?? null,
    });

    res.status(200).json({
      chain,
      walletAddress: generated.address,
      custodyTier: 'custodial',
      label: label ?? null,
    });
  } catch (err) {
    console.error('Error in walletProvision:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'InternalServerError', message: 'Failed to provision wallet' });
    }
  }
}
