import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { query } from '../db/client.js';
import { buildDidAugmentation, type LinkedWalletInput } from '../identity/did-augment.js';
import { resolveChainIdCaip2 } from '../identity/siwof.js';

/**
 * GET net.openfederation.identity.getDidAugmentation
 *
 * Returns W3C DID Core verificationMethod / assertionMethod / authentication
 * entries for the caller's active wallet links. For did:web users this is
 * the same material we inject into /.well-known/did.json; for did:plc users
 * it's the "sidecar" a dApp fetches since we can't edit the PLC doc.
 *
 * Unauthenticated — the response is fully public and derivable from the
 * user's public wallet bindings.
 */
export default async function getDidAugmentation(req: AuthRequest, res: Response): Promise<void> {
  try {
    const did = (typeof req.query.did === 'string' ? req.query.did : '').trim();
    if (!did || !did.startsWith('did:')) {
      res.status(400).json({ error: 'InvalidRequest', message: 'did is required' });
      return;
    }

    const result = await query<{
      chain: 'ethereum' | 'solana';
      wallet_address: string;
      is_primary: boolean;
    }>(
      `SELECT chain, wallet_address, is_primary
       FROM wallet_links
       WHERE user_did = $1 AND custody_status = 'active'
       ORDER BY is_primary DESC, chain, linked_at`,
      [did]
    );

    const wallets: LinkedWalletInput[] = result.rows.map((r) => ({
      chain: r.chain,
      walletAddress: r.wallet_address,
      chainIdCaip2: resolveChainIdCaip2(r.chain),
      isPrimary: r.is_primary,
    }));

    const augmentation = buildDidAugmentation(did, wallets);
    res.status(200).json({
      '@context': [
        'https://www.w3.org/ns/did/v1',
        'https://w3id.org/security/suites/secp256k1-2019/v1',
        'https://w3id.org/security/suites/ed25519-2020/v1',
      ],
      did,
      ...augmentation,
    });
  } catch (err) {
    console.error('Error in getDidAugmentation:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'InternalServerError', message: 'Failed to build DID augmentation' });
    }
  }
}
