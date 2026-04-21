import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireApprovedUser } from '../auth/guards.js';
import { verifyPassword } from '../auth/password.js';
import { query } from '../db/client.js';
import { auditLog } from '../db/audit.js';
import { loadCustodialKey, isWalletChain } from '../wallet/index.js';

/**
 * POST net.openfederation.wallet.retrieveForUpgrade
 *
 * One-shot export of the caller's Tier 1 (custodial) private key, in
 * preparation for a tier upgrade. Required for:
 *   Tier 1 → Tier 2 — client re-wraps the key with a passphrase and uploads
 *                      the encrypted blob via finalizeTierChange
 *   Tier 1 → Tier 3 — client takes the key into self-custody and calls
 *                      finalizeTierChange to drop the PDS copy
 *
 * Tier 2 wallets do NOT use this endpoint: the user already owns the
 * encryption passphrase and can unwrap the existing custodial_secrets blob
 * locally without server involvement.
 *
 * This endpoint is the one destructive-to-attacker step in the whole
 * upgrade flow (it leaks plaintext key material), so it requires the user
 * to re-enter their password in-band. Audit-logged.
 */
export default async function retrieveForUpgrade(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireApprovedUser(req, res)) return;

    const { chain, walletAddress, currentPassword } = req.body ?? {};

    if (!chain || !isWalletChain(chain)) {
      res.status(400).json({ error: 'UnsupportedChain', message: 'chain must be "ethereum" or "solana"' });
      return;
    }
    if (!walletAddress || typeof walletAddress !== 'string') {
      res.status(400).json({ error: 'InvalidRequest', message: 'walletAddress is required' });
      return;
    }
    if (!currentPassword || typeof currentPassword !== 'string') {
      res.status(400).json({ error: 'InvalidRequest', message: 'currentPassword is required' });
      return;
    }

    const userDid = req.auth!.did;
    const userId = req.auth!.userId;
    const addr = chain === 'ethereum' ? walletAddress.toLowerCase() : walletAddress;

    // Password re-auth. Rejects external-auth users — they go through OAuth
    // and don't hold a local password, so this endpoint isn't available to
    // them (they can recover via their home PDS's rotation flow).
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
        message: 'Upgrade requires a local password; external-auth accounts cannot retrieve custodial keys',
      });
      return;
    }
    const passwordValid = await verifyPassword(currentPassword, userRow.rows[0].password_hash);
    if (!passwordValid) {
      res.status(401).json({ error: 'InvalidPassword', message: 'Current password is incorrect' });
      return;
    }

    // Wallet must be a Tier 1 active wallet owned by the caller.
    const tierRow = await query<{ custody_tier: string; custody_status: string }>(
      `SELECT custody_tier, custody_status FROM wallet_links
       WHERE user_did = $1 AND chain = $2 AND wallet_address = $3`,
      [userDid, chain, addr]
    );
    if (tierRow.rows.length === 0) {
      res.status(404).json({ error: 'WalletNotFound', message: 'No such wallet for this DID' });
      return;
    }
    if (tierRow.rows[0].custody_status !== 'active') {
      res.status(409).json({ error: 'WalletInactive', message: `Wallet is ${tierRow.rows[0].custody_status}` });
      return;
    }
    if (tierRow.rows[0].custody_tier !== 'custodial') {
      res.status(409).json({
        error: 'UnsupportedTier',
        message: 'retrieveForUpgrade is only applicable to Tier 1 wallets; Tier 2 users already hold the encrypted blob',
      });
      return;
    }

    const privateKey = await loadCustodialKey(userDid, chain, addr);
    if (!privateKey) {
      res.status(500).json({ error: 'SigningFailed', message: 'Custodial key material is missing' });
      return;
    }

    const privateKeyBase64 = privateKey.toString('base64');
    privateKey.fill(0);

    await auditLog('wallet.retrieveForUpgrade', userId, userDid, {
      chain,
      walletAddress: addr,
    });

    res.status(200).json({
      chain,
      walletAddress: addr,
      privateKeyBase64,
      exportFormat: chain === 'ethereum' ? 'raw-secp256k1-32-bytes' : 'raw-ed25519-64-bytes',
    });
  } catch (err) {
    console.error('Error in retrieveForUpgrade:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'InternalServerError', message: 'Failed to retrieve key for upgrade' });
    }
  }
}
