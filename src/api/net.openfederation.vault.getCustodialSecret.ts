import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireAuth } from '../auth/guards.js';
import { query } from '../db/client.js';

/**
 * Retrieve the encrypted custodial secret for the authenticated user's given chain.
 * Returns 404 if not found. The blob is returned as-is — the PDS never decrypts it.
 *
 * GET net.openfederation.vault.getCustodialSecret?chain=<chain>
 */
export default async function getCustodialSecret(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireAuth(req, res)) return;

    const chain = req.query.chain as string | undefined;
    if (!chain || typeof chain !== 'string' || chain.length > 64) {
      res.status(400).json({ error: 'InvalidRequest', message: 'chain is required (max 64 chars)' });
      return;
    }

    const result = await query<{
      secret_type: string;
      chain: string;
      encrypted_blob: string;
      wallet_address: string;
      created_at: string;
    }>(
      `SELECT secret_type, chain, encrypted_blob, wallet_address, created_at
       FROM custodial_secrets
       WHERE user_did = $1 AND chain = $2`,
      [req.auth.did, chain],
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'NotFound', message: 'No custodial secret found for this chain' });
      return;
    }

    const row = result.rows[0];
    res.json({
      secretType: row.secret_type,
      chain: row.chain,
      encryptedBlob: row.encrypted_blob,
      walletAddress: row.wallet_address,
      createdAt: row.created_at,
    });
  } catch (error) {
    console.error('Error retrieving custodial secret:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to retrieve custodial secret.' });
  }
}
