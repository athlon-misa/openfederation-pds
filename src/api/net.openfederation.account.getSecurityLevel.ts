import { Response } from 'express';
import { requireAuth } from '../auth/guards.js';
import { query } from '../db/client.js';
import { getUserShares } from '../vault/vault-store.js';
import type { AuthRequest } from '../auth/types.js';

type TierName = 'standard' | 'enhanced' | 'self-custodial';

function tierName(tier: number): TierName {
  if (tier >= 3) return 'self-custodial';
  if (tier === 2) return 'enhanced';
  return 'standard';
}

function upgradePath(tier: number, checklist: Record<string, boolean>): string | null {
  if (tier === 1) {
    if (!checklist.recoveryEmail) {
      return 'Verify your recovery email to strengthen your account security.';
    }
    return 'Register an escrow provider and set up 2-of-3 threshold recovery to reach Enhanced tier.';
  }
  if (tier === 2) {
    if (!checklist.keyExported) {
      return 'Export your recovery key for full self-custodial control (Tier 3).';
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
      checklist,
      upgradePath: upgradePath(recoveryTier, checklist),
    });
  } catch (error) {
    console.error('Error getting security level:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to get security level.' });
  }
}
