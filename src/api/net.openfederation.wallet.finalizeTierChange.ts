import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireApprovedUser } from '../auth/guards.js';
import { verifyPassword } from '../auth/password.js';
import { getClient, query } from '../db/client.js';
import { auditLog } from '../db/audit.js';
import { isWalletChain, isCustodyTier } from '../wallet/index.js';

const MAX_BLOB_LEN = 65536; // matches custodial_secrets TEXT blob cap

/**
 * POST net.openfederation.wallet.finalizeTierChange
 *
 * Atomic state swap at the end of a tier upgrade. Depending on the current
 * tier and the requested `newTier`:
 *
 *   Tier 1 → Tier 2 — deletes the `wallet_custody` row AND upserts a
 *                      `custodial_secrets` row with the caller-provided
 *                      `newEncryptedBlob` (the mnemonic/key the client
 *                      wrapped locally after retrieveForUpgrade).
 *   Tier 1 → Tier 3 — deletes the `wallet_custody` row.
 *   Tier 2 → Tier 3 — deletes any `custodial_secrets` row for the wallet's
 *                      chain (the user has the mnemonic offline now).
 *   Tier 2 → Tier 1 — NOT SUPPORTED (would require the user to hand plaintext
 *                      to the server, breaking the Tier 2 contract).
 *   Tier 3 → *      — NOT SUPPORTED (PDS holds nothing to transition).
 *
 * Also revokes any active per-dApp consent grants scoped to the wallet —
 * those grants only make sense for a Tier 1 wallet.
 *
 * Requires password re-auth because it can make a Tier 2 wallet unreachable
 * if the user's session is hijacked (by dropping the encrypted blob the
 * user needs to re-derive the key).
 */
export default async function finalizeTierChange(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireApprovedUser(req, res)) return;

    const { chain, walletAddress, newTier, newEncryptedBlob, currentPassword } = req.body ?? {};

    if (!chain || !isWalletChain(chain)) {
      res.status(400).json({ error: 'UnsupportedChain', message: 'chain must be "ethereum" or "solana"' });
      return;
    }
    if (!walletAddress || typeof walletAddress !== 'string') {
      res.status(400).json({ error: 'InvalidRequest', message: 'walletAddress is required' });
      return;
    }
    if (!isCustodyTier(newTier)) {
      res.status(400).json({ error: 'InvalidRequest', message: 'newTier must be custodial, user_encrypted, or self_custody' });
      return;
    }
    if (newTier === 'custodial') {
      res.status(400).json({
        error: 'UnsupportedTransition',
        message: 'Downgrading to Tier 1 (custodial) is not supported — create a new wallet for that instead',
      });
      return;
    }
    if (newTier === 'user_encrypted') {
      if (typeof newEncryptedBlob !== 'string' || newEncryptedBlob.length === 0 || newEncryptedBlob.length > MAX_BLOB_LEN) {
        res.status(400).json({
          error: 'InvalidRequest',
          message: `newEncryptedBlob is required for Tier 2 and must be 1-${MAX_BLOB_LEN} chars`,
        });
        return;
      }
    }
    if (!currentPassword || typeof currentPassword !== 'string') {
      res.status(400).json({ error: 'InvalidRequest', message: 'currentPassword is required' });
      return;
    }

    const userDid = req.auth!.did;
    const userId = req.auth!.userId;
    const addr = chain === 'ethereum' ? walletAddress.toLowerCase() : walletAddress;

    // Password re-auth (same reasoning as retrieveForUpgrade).
    const userRow = await query<{ auth_type: string; password_hash: string | null }>(
      'SELECT auth_type, password_hash FROM users WHERE id = $1',
      [userId]
    );
    if (userRow.rows.length === 0) {
      res.status(404).json({ error: 'NotFound', message: 'User not found' });
      return;
    }
    if (userRow.rows[0].auth_type === 'external' || !userRow.rows[0].password_hash) {
      res.status(400).json({
        error: 'InvalidRequest',
        message: 'Tier change requires a local password; external-auth accounts cannot use this endpoint',
      });
      return;
    }
    const passwordValid = await verifyPassword(currentPassword, userRow.rows[0].password_hash);
    if (!passwordValid) {
      res.status(401).json({ error: 'InvalidPassword', message: 'Current password is incorrect' });
      return;
    }

    const client = await getClient();
    try {
      await client.query('BEGIN');

      const tierRow = await client.query<{ custody_tier: string; custody_status: string }>(
        `SELECT custody_tier, custody_status FROM wallet_links
         WHERE user_did = $1 AND chain = $2 AND wallet_address = $3
         FOR UPDATE`,
        [userDid, chain, addr]
      );
      if (tierRow.rows.length === 0) {
        await client.query('ROLLBACK');
        res.status(404).json({ error: 'WalletNotFound', message: 'No such wallet for this DID' });
        return;
      }
      if (tierRow.rows[0].custody_status !== 'active') {
        await client.query('ROLLBACK');
        res.status(409).json({ error: 'WalletInactive', message: `Wallet is ${tierRow.rows[0].custody_status}` });
        return;
      }

      const currentTier = tierRow.rows[0].custody_tier;

      // Validate the requested transition.
      const allowed =
        (currentTier === 'custodial' && (newTier === 'user_encrypted' || newTier === 'self_custody')) ||
        (currentTier === 'user_encrypted' && newTier === 'self_custody');
      if (!allowed) {
        await client.query('ROLLBACK');
        res.status(409).json({
          error: 'UnsupportedTransition',
          message: `Cannot transition ${currentTier} → ${newTier}; tier upgrades are one-way (1→2, 1→3, 2→3). Create a new wallet for other transitions.`,
        });
        return;
      }

      // 1. Drop the existing custody record for the current tier.
      if (currentTier === 'custodial') {
        await client.query(
          `DELETE FROM wallet_custody
           WHERE user_did = $1 AND chain = $2 AND wallet_address = $3`,
          [userDid, chain, addr]
        );
      } else if (currentTier === 'user_encrypted' && newTier === 'self_custody') {
        // Delete the custodial_secrets blob for this chain. Note:
        // custodial_secrets has UNIQUE(user_did, chain) so this drops all
        // blobs for the chain — acceptable since we model one wrapped
        // master secret per chain.
        await client.query(
          `DELETE FROM custodial_secrets WHERE user_did = $1 AND chain = $2`,
          [userDid, chain]
        );
      }

      // 2. If moving to Tier 2, upsert the new wrapped blob.
      if (newTier === 'user_encrypted') {
        await client.query(
          `INSERT INTO custodial_secrets (user_did, chain, secret_type, encrypted_blob, wallet_address)
           VALUES ($1, $2, 'bip39-mnemonic-wrapped', $3, $4)
           ON CONFLICT (user_did, chain) DO UPDATE SET
             secret_type = EXCLUDED.secret_type,
             encrypted_blob = EXCLUDED.encrypted_blob,
             wallet_address = EXCLUDED.wallet_address,
             updated_at = NOW()`,
          [userDid, chain, newEncryptedBlob, addr]
        );
      }

      // 3. Update the wallet_links tier.
      await client.query(
        `UPDATE wallet_links SET custody_tier = $1
         WHERE user_did = $2 AND chain = $3 AND wallet_address = $4`,
        [newTier, userDid, chain, addr]
      );

      // 4. Revoke any active consent grants scoped to this wallet. Those
      //    grants only make sense for Tier 1 signing.
      await client.query(
        `UPDATE wallet_dapp_consents
           SET revoked_at = NOW()
         WHERE user_did = $1 AND chain = $2 AND wallet_address = $3 AND revoked_at IS NULL`,
        [userDid, chain, addr]
      );

      await client.query('COMMIT');

      await auditLog('wallet.tierChange', userId, userDid, {
        chain,
        walletAddress: addr,
        from: currentTier,
        to: newTier,
      });

      res.status(200).json({
        chain,
        walletAddress: addr,
        previousTier: currentTier,
        newTier,
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('Error in finalizeTierChange:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'InternalServerError', message: 'Failed to finalize tier change' });
    }
  }
}
