import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireAuth } from '../auth/guards.js';
import { query } from '../db/client.js';
import { logVaultAudit } from '../vault/vault-store.js';

/**
 * Store (upsert) an encrypted custodial secret for the authenticated user.
 * The blob is opaque — the PDS never decrypts it.
 *
 * POST net.openfederation.vault.storeCustodialSecret
 * Body: { secretType, chain, encryptedBlob, walletAddress }
 * Returns: { success: true, secretId }
 */
export default async function storeCustodialSecret(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireAuth(req, res)) return;

    const { secretType, chain, encryptedBlob, walletAddress } = req.body as Record<string, unknown>;

    if (!secretType || typeof secretType !== 'string' || secretType.length > 64) {
      res.status(400).json({ error: 'InvalidRequest', message: 'secretType is required (max 64 chars)' });
      return;
    }
    if (!chain || typeof chain !== 'string' || chain.length > 64) {
      res.status(400).json({ error: 'InvalidRequest', message: 'chain is required (max 64 chars)' });
      return;
    }
    if (!encryptedBlob || typeof encryptedBlob !== 'string' || encryptedBlob.length > 65536) {
      res.status(400).json({ error: 'InvalidRequest', message: 'encryptedBlob is required (max 65536 chars)' });
      return;
    }
    if (!walletAddress || typeof walletAddress !== 'string' || walletAddress.length > 256) {
      res.status(400).json({ error: 'InvalidRequest', message: 'walletAddress is required (max 256 chars)' });
      return;
    }

    const result = await query<{ id: string }>(
      `INSERT INTO custodial_secrets (user_did, chain, secret_type, encrypted_blob, wallet_address)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_did, chain) DO UPDATE
         SET secret_type = EXCLUDED.secret_type,
             encrypted_blob = EXCLUDED.encrypted_blob,
             wallet_address = EXCLUDED.wallet_address,
             updated_at = NOW()
       RETURNING id`,
      [req.auth.did, chain, secretType, encryptedBlob, walletAddress],
    );
    const secretId = result.rows[0].id;

    await logVaultAudit(req.auth.did, 'custody_stored', req.auth.did, undefined, {
      chain,
      secretType,
      walletAddress,
    });

    res.json({ success: true, secretId });
  } catch (error) {
    console.error('Error storing custodial secret:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to store custodial secret.' });
  }
}
