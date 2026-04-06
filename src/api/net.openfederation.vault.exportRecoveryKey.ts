import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireAuth, requireApprovedUser } from '../auth/guards.js';
import { getShare, updateRecoveryTier, logVaultAudit } from '../vault/vault-store.js';
import { query } from '../db/client.js';

/**
 * Export the vault share (Share 2) for the user to combine with their device Share 1.
 * Elevated verification required — must have completed admin.verifyChallenge within 30 minutes.
 * After export, upgrades recovery tier to 3 (self-custodial).
 */
export default async function exportRecoveryKey(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireAuth(req, res)) return;
    if (!requireApprovedUser(req, res)) return;

    const userDid = req.auth.did;

    // Elevated verification required — recent admin.verifyChallenge
    const result = await query(
      `SELECT 1 FROM audit_log
       WHERE target_id = $1 AND action = 'admin.verification.success'
       AND created_at > NOW() - INTERVAL '30 minutes'
       LIMIT 1`,
      [req.auth.userId]
    );

    if (result.rows.length === 0) {
      res.status(403).json({
        error: 'VerificationRequired',
        message: 'Identity verification required. Complete admin.createVerificationChallenge and admin.verifyChallenge first.',
      });
      return;
    }

    // Retrieve and decrypt Share 2 (vault share)
    const share = await getShare(userDid, 2);
    if (!share) {
      res.status(404).json({
        error: 'ShareNotFound',
        message: 'No vault share found for this account.',
      });
      return;
    }

    // Upgrade recovery tier to 3 (self-custodial)
    await updateRecoveryTier(userDid, 3);

    // Audit the export
    await logVaultAudit(userDid, 'key.exported', userDid, 2, { newRecoveryTier: 3 });

    res.json({
      share,
      recoveryTier: 3,
      message: 'Vault share exported. Combine with your device share to reconstruct the rotation key. Store securely.',
    });
  } catch (error) {
    console.error('Error exporting recovery key:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to export recovery key.' });
  }
}
