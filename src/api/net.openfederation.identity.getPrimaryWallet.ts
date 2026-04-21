import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { query } from '../db/client.js';
import { isWalletChain } from '../wallet/index.js';
import { signServiceAuthJwt } from '../auth/service-auth.js';
import { getKeypairForDid } from '../repo/keypair-utils.js';
import { resolveChainIdCaip2, toCaip10 } from '../identity/siwof.js';

const PROOF_TTL_SEC = 5 * 60; // match SIWOF didToken TTL

/**
 * GET net.openfederation.identity.getPrimaryWallet
 *
 * Public DID→wallet resolver. Given a DID + chain, returns that user's
 * primary wallet on that chain (the one they've opted to advertise) plus a
 * detached service-auth JWT signed by the user's atproto key.
 *
 * The proof JWT lets the caller verify the (DID, wallet, chain) binding
 * cryptographically via standard W3C DID resolution — no trust in
 * OpenFederation required.
 *
 * Unauthenticated.
 */
export default async function getPrimaryWallet(req: AuthRequest, res: Response): Promise<void> {
  try {
    const did = (typeof req.query.did === 'string' ? req.query.did : '').trim();
    const chainParam = typeof req.query.chain === 'string' ? req.query.chain : '';
    const includeProof = req.query.includeProof !== 'false'; // default true

    if (!did || !did.startsWith('did:')) {
      res.status(400).json({ error: 'InvalidRequest', message: 'did is required' });
      return;
    }
    if (!chainParam || !isWalletChain(chainParam)) {
      res.status(400).json({ error: 'UnsupportedChain', message: 'chain must be "ethereum" or "solana"' });
      return;
    }

    const result = await query<{
      wallet_address: string;
      label: string | null;
      linked_at: Date;
      custody_tier: string;
    }>(
      `SELECT wallet_address, label, linked_at, custody_tier
       FROM wallet_links
       WHERE user_did = $1 AND chain = $2 AND is_primary = TRUE AND custody_status = 'active'
       LIMIT 1`,
      [did, chainParam]
    );

    if (result.rows.length === 0) {
      res.status(404).json({
        error: 'NoPrimaryWallet',
        message: 'No primary wallet for this DID on this chain',
      });
      return;
    }

    const row = result.rows[0];
    const chainIdCaip2 = resolveChainIdCaip2(chainParam);

    // Resolve handle for display.
    const handleRes = await query<{ handle: string }>(
      'SELECT handle FROM users WHERE did = $1',
      [did]
    );
    const handle = handleRes.rows[0]?.handle ?? null;

    let proof: string | null = null;
    if (includeProof) {
      try {
        const keypair = await getKeypairForDid(did);
        const exp = Math.floor(Date.now() / 1000) + PROOF_TTL_SEC;
        proof = await signServiceAuthJwt({
          keypair,
          iss: did,
          aud: 'did:openfederation:public-wallet-resolver',
          exp,
          lxm: 'net.openfederation.identity.getPrimaryWallet',
          extraClaims: {
            sub: toCaip10(chainIdCaip2, row.wallet_address),
            walletAddress: row.wallet_address,
            chain: chainParam,
            chainIdCaip2,
          },
        });
      } catch {
        // If no signing key, omit proof but still return the binding.
        proof = null;
      }
    }

    res.status(200).json({
      did,
      handle,
      chain: chainParam,
      chainIdCaip2,
      walletAddress: row.wallet_address,
      label: row.label,
      linkedAt: row.linked_at instanceof Date ? row.linked_at.toISOString() : row.linked_at,
      custodyTier: row.custody_tier,
      ...(proof ? { proof } : {}),
    });
  } catch (err) {
    console.error('Error in getPrimaryWallet:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'InternalServerError', message: 'Failed to resolve primary wallet' });
    }
  }
}
