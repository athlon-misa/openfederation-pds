import { Response } from 'express';
import { requireAuth } from '../auth/guards.js';
import { query } from '../db/client.js';
import { getUserShares } from '../vault/vault-store.js';
import { holdsRotationKey } from '../identity/plc-ops.js';
import type { AuthRequest } from '../auth/types.js';

/**
 * Every tier is custodial (#239): this PDS holds shares 2 and 3 of the
 * rotation key, enough to rebuild it. The tiers record what the user has
 * added on top: an escrow provider on record, and their own copy of the key.
 * Real self-custody (no rotation key here) is the separate `self` mode.
 */
type TierName = 'custodial' | 'escrow-recorded' | 'key-exported';

function tierName(tier: number): TierName {
  if (tier >= 3) return 'key-exported';
  if (tier === 2) return 'escrow-recorded';
  return 'custodial';
}

function upgradePath(tier: number, checklist: Record<string, boolean>): string | null {
  if (tier === 1) {
    if (!checklist.recoveryEmail) {
      return 'Verify your recovery email to strengthen your account security.';
    }
    return 'Export your rotation key to keep your own backup: with it you can move your account without this server\'s help.';
  }
  if (tier === 2) {
    if (!checklist.keyExported) {
      return 'Export your rotation key to keep your own backup: with it you can move your account without this server\'s help.';
    }
    return null;
  }
  return null;
}

export default async function getSecurityLevel(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireAuth(req, res)) return;

    const userDid = req.auth.did;

    // Fetch user recovery columns
    const userResult = await query<{
      recovery_tier: number;
      recovery_email_verified: boolean;
    }>(
      'SELECT recovery_tier, recovery_email_verified FROM users WHERE did = $1',
      [userDid]
    );

    if (userResult.rows.length === 0) {
      res.status(404).json({ error: 'NotFound', message: 'User not found.' });
      return;
    }

    const user = userResult.rows[0];
    const recoveryTier = user.recovery_tier ?? 1;
    const recoveryEmailVerified = user.recovery_email_verified ?? false;

    // Check vault shares
    let vaultShares = false;
    let escrowRegistered = false;
    try {
      const shares = await getUserShares(userDid);
      vaultShares = shares.length > 0;
      escrowRegistered = shares.some(s => s.shareHolder === 'escrow');
    } catch {
      // vault_shares table may not exist yet; treat as no shares
    }

    const checklist = {
      passkey: true, // auth works if we got here
      recoveryEmail: recoveryEmailVerified,
      vaultShares,
      escrowRegistered,
      keyExported: recoveryTier >= 3,
    };

    res.status(200).json({
      recoveryTier,
      tierName: tierName(recoveryTier),
      // True whenever this server can rebuild the rotation key on its own.
      pdsHoldsRotationKey: await holdsRotationKey(userDid),
      checklist,
      upgradePath: upgradePath(recoveryTier, checklist),
    });
  } catch (error) {
    console.error('Error getting security level:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to get security level.' });
  }
}
