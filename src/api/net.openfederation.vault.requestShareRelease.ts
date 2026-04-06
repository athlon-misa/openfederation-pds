import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireAuth, requireApprovedUser } from '../auth/guards.js';
import { getShare, logVaultAudit } from '../vault/vault-store.js';
import { query } from '../db/client.js';

/**
 * Release the vault share (Share 2) to the authenticated user.
 * Requires recent identity verification (admin.verifyChallenge within 30 minutes)
 * or a verificationToken in the request body.
 */
export default async function requestShareRelease(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireAuth(req, res)) return;
    if (!requireApprovedUser(req, res)) return;

    const { verificationToken } = req.body || {};
    const userDid = req.auth.did;

    // Check for recent identity verification
    const verified = await checkRecentVerification(req.auth.userId, verificationToken);
    if (!verified) {
      res.status(403).json({
        error: 'VerificationRequired',
        message: 'Identity verification required. Complete admin.verifyChallenge first or provide a verificationToken.',
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
    await logVaultAudit(userDid, 'share.released', userDid, 2, {
      method: verificationToken ? 'verificationToken' : 'recentChallenge',
    });

    res.json({ share });
  } catch (error) {
    console.error('Error releasing vault share:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to release share.' });
  }
}

/**
 * Check if the user has a recent admin.verifyChallenge audit entry (within 30 minutes)
 * or a valid verification token.
 */
async function checkRecentVerification(userId: string, verificationToken?: string): Promise<boolean> {
  // Check for recent audit entry from admin.verifyChallenge (admin.verification.success)
  const result = await query(
    `SELECT 1 FROM audit_log
     WHERE actor_id = $1 AND action = 'admin.verification.success'
     AND created_at > NOW() - INTERVAL '30 minutes'
     LIMIT 1`,
    [userId]
  );

  if (result.rows.length > 0) return true;

  // If a verification token is provided, check it against the audit log
  if (verificationToken) {
    const tokenResult = await query(
      `SELECT 1 FROM audit_log
       WHERE actor_id = $1 AND action = 'admin.verification.success'
       AND meta->>'nonce' = $2
       AND created_at > NOW() - INTERVAL '30 minutes'
       LIMIT 1`,
      [userId, verificationToken]
    );
    return tokenResult.rows.length > 0;
  }

  return false;
}
