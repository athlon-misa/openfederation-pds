import { Response } from 'express';
import crypto from 'crypto';
import type { AuthRequest } from '../auth/types.js';
import { requireAuth, requireApprovedUser } from '../auth/guards.js';
import { logVaultAudit, getUserShares } from '../vault/vault-store.js';
import { getClient } from '../db/client.js';

const DID_PATTERN = /^did:[a-z]+:.+$/;

/**
 * Register an external escrow provider for Share 3.
 * Transitions user from recovery tier 1 to tier 2.
 * All DB mutations run in a single transaction.
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

    if (typeof escrowProviderDid !== 'string' || !DID_PATTERN.test(escrowProviderDid)) {
      res.status(400).json({
        error: 'InvalidRequest',
        message: 'escrowProviderDid must be a valid DID (did:<method>:<id>).',
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

    // Wrap all mutations in a transaction to prevent partial state
    const client = await getClient();
    try {
      await client.query('BEGIN');

      // Register escrow provider if not already registered
      const existingProvider = await client.query(
        'SELECT id FROM escrow_providers WHERE did = $1',
        [escrowProviderDid]
      );

      if (existingProvider.rows.length === 0) {
        const providerId = crypto.randomUUID();
        await client.query(
          `INSERT INTO escrow_providers (id, did, name, verification_url, registered_by)
           VALUES ($1, $2, $3, $4, $5)`,
          [providerId, escrowProviderDid, escrowProviderName, verificationUrl || null, userDid]
        );
      }

      // Update Share 3: holder from 'vault' to 'escrow', set provider DID
      await client.query(
        `UPDATE vault_shares SET share_holder = $1, escrow_provider_did = $2, updated_at = CURRENT_TIMESTAMP
         WHERE user_did = $3 AND share_index = $4`,
        ['escrow', escrowProviderDid, userDid, 3]
      );

      // Upgrade recovery tier to 2 (only for this user's shares)
      await client.query(
        `UPDATE vault_shares SET recovery_tier = $1, updated_at = CURRENT_TIMESTAMP
         WHERE user_did = $2`,
        [2, userDid]
      );

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    // Audit the escrow registration (outside transaction — non-critical)
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
