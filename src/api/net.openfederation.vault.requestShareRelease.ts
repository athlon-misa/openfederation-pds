import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireAuth, requireApprovedUser } from '../auth/guards.js';
import { getShare, logVaultAudit } from '../vault/vault-store.js';
import { query } from '../db/client.js';

/**
 * Release the vault share (Share 2) to the authenticated user.
 * Requires recent identity verification (admin.verifyChallenge within 30 minutes).
 *
 * Flow: user calls admin.createVerificationChallenge → receives nonce via email →
 * calls admin.verifyChallenge → then calls this endpoint within 30 minutes.
 */
export default async function requestShareRelease(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireAuth(req, res)) return;
    if (!requireApprovedUser(req, res)) return;

    const userDid = req.auth.did;

    // Check for recent identity verification (audit entry within 30 minutes)
    const verified = await hasRecentVerification(req.auth.userId);
    if (!verified) {
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

    // Audit the release
    await logVaultAudit(userDid, 'share.released', userDid, 2);

    res.json({ share });
  } catch (error) {
    console.error('Error releasing vault share:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to release share.' });
  }
}

/**
 * Check if the user has completed identity verification within the last 30 minutes.
 * Looks for an 'admin.verification.success' audit entry where this user is the target.
 */
async function hasRecentVerification(userId: string): Promise<boolean> {
  const result = await query(
    `SELECT 1 FROM audit_log
     WHERE target_id = $1 AND action = 'admin.verification.success'
     AND created_at > NOW() - INTERVAL '30 minutes'
     LIMIT 1`,
    [userId]
  );
  return result.rows.length > 0;
}
