import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireAuth, requireApprovedUser, refuseCustodyModes } from '../auth/guards.js';
import { getShare, updateRecoveryTier, logVaultAudit } from '../vault/vault-store.js';
import { combineShares } from '../vault/shamir.js';
import { query } from '../db/client.js';

/**
 * Hand the user their PLC rotation key: a working backup (#239). With it they
 * can sign PLC operations themselves, for example to move to another PDS
 * without this one's help. This server keeps its shares, so custody stays
 * custodial: the response says so. (Exporting one share was useless: share 1,
 * the "device share" it was meant to combine with, was never kept anywhere.)
 *
 * Needs an identity verification (admin.verifyChallenge) in the last 30
 * minutes, and each verification allows one export.
 */
export default async function exportRecoveryKey(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireAuth(req, res)) return;
    if (!requireApprovedUser(req, res)) return;
    if (!(await refuseCustodyModes(req, res, ['self'], 'This account holds its own rotation key (self custody); this server keeps none for it.'))) return;

    const userDid = req.auth.did;

    // A recent verification that no export has used yet.
    const verified = await query<{ created_at: Date }>(
      `SELECT created_at FROM audit_log
       WHERE target_id = $1 AND action = 'admin.verification.success'
       AND created_at > NOW() - INTERVAL '30 minutes'
       ORDER BY created_at DESC LIMIT 1`,
      [req.auth.userId]
    );
    const usedSince = verified.rows[0] && (await query(
      `SELECT 1 FROM vault_audit_log WHERE user_did = $1 AND action = 'key.exported' AND created_at >= $2 LIMIT 1`,
      [userDid, verified.rows[0].created_at])).rows.length > 0;
    if (!verified.rows[0] || usedSince) {
      res.status(403).json({
        error: 'VerificationRequired',
        message: 'Identity verification required for each export. Complete admin.createVerificationChallenge and admin.verifyChallenge first.',
      });
      return;
    }

    const [share2, share3] = await Promise.all([getShare(userDid, 2), getShare(userDid, 3)]);
    if (!share2 || !share3) {
      res.status(404).json({ error: 'ShareNotFound', message: 'This server does not hold a rotation key for this account.' });
      return;
    }
    const key = combineShares([share2, share3]);
    const rotationKey = key.toString('base64');
    key.fill(0);

    await updateRecoveryTier(userDid, 3);
    await query('UPDATE users SET recovery_tier = 3 WHERE did = $1', [userDid]);
    await logVaultAudit(userDid, 'key.exported', userDid, undefined, { newRecoveryTier: 3, exported: 'rotation-key' });

    res.json({
      rotationKey,
      recoveryTier: 3,
      pdsHoldsRotationKey: true,
      message: 'This is your PLC rotation key (secp256k1, base64). Keep it offline: whoever holds it controls your identity. This server still holds the key too.',
    });
  } catch (error) {
    console.error('Error exporting recovery key:', error instanceof Error ? error.message : error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to export recovery key.' });
  }
}
