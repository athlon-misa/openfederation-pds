import { Response } from 'express';
import crypto from 'crypto';
import type { AuthRequest } from '../auth/types.js';
import { requireAuth, requireApprovedUser } from '../auth/guards.js';
import { updateShareHolder, updateRecoveryTier, logVaultAudit, getUserShares } from '../vault/vault-store.js';
import { query } from '../db/client.js';

/**
 * Register an external escrow provider for Share 3.
 * Transitions user from recovery tier 1 to tier 2.
 */
export default async function registerEscrow(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireAuth(req, res)) return;
    if (!requireApprovedUser(req, res)) return;

    const { escrowProviderDid, escrowProviderName, verificationUrl } = req.body || {};
    const userDid = req.auth.did;

    if (!escrowProviderDid || !escrowProviderName) {
      res.status(400).json({
        error: 'InvalidRequest',
        message: 'escrowProviderDid and escrowProviderName are required.',
      });
      return;
    }

    // Verify user has vault shares
    const shares = await getUserShares(userDid);
    const share3 = shares.find(s => s.shareIndex === 3);
    if (!share3) {
      res.status(404).json({
        error: 'ShareNotFound',
        message: 'No Share 3 found for this account.',
      });
      return;
    }

    if (share3.shareHolder === 'escrow') {
      res.status(409).json({
        error: 'EscrowAlreadyRegistered',
        message: 'Share 3 is already assigned to an escrow provider.',
      });
      return;
    }

    // Register escrow provider if not already registered
    const existingProvider = await query(
      'SELECT id FROM escrow_providers WHERE did = $1',
      [escrowProviderDid]
    );

    if (existingProvider.rows.length === 0) {
      const providerId = crypto.randomUUID();
      await query(
        `INSERT INTO escrow_providers (id, did, name, verification_url, registered_by)
         VALUES ($1, $2, $3, $4, $5)`,
        [providerId, escrowProviderDid, escrowProviderName, verificationUrl || null, userDid]
      );
    }

    // Update Share 3 holder from 'vault' to 'escrow'
    await updateShareHolder(userDid, 3, 'escrow', escrowProviderDid);

    // Upgrade recovery tier from 1 to 2
    await updateRecoveryTier(userDid, 2);

    // Audit the escrow registration
    await logVaultAudit(userDid, 'escrow.registered', userDid, 3, {
      escrowProviderDid,
      escrowProviderName,
      previousHolder: share3.shareHolder,
    });

    res.json({
      success: true,
      recoveryTier: 2,
      escrowProviderDid,
      message: 'Escrow provider registered. Recovery tier upgraded to 2.',
    });
  } catch (error) {
    console.error('Error registering escrow:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to register escrow provider.' });
  }
}
