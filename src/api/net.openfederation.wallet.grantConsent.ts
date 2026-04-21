import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireApprovedUser } from '../auth/guards.js';
import { auditLog } from '../db/audit.js';
import {
  grantConsent,
  isWalletChain,
  MAX_CONSENT_TTL_SEC,
  MIN_CONSENT_TTL_SEC,
  DEFAULT_CONSENT_TTL_SEC,
} from '../wallet/index.js';

/**
 * POST net.openfederation.wallet.grantConsent
 *
 * Issues a time-bounded consent grant allowing a specific dApp origin to
 * request signatures from the user's Tier 1 wallet(s). Scope can be:
 *   - a single (chain, walletAddress) — preferred
 *   - all Tier 1 wallets (omit chain + walletAddress)
 *
 * TTL defaults to 7 days, capped at 30. The user can revoke early via
 * `revokeConsent`.
 */
export default async function walletGrantConsent(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireApprovedUser(req, res)) return;

    const { dappOrigin, chain, walletAddress, ttlSeconds } = req.body ?? {};

    if (!dappOrigin || typeof dappOrigin !== 'string') {
      res.status(400).json({ error: 'InvalidRequest', message: 'dappOrigin is required' });
      return;
    }

    if (chain !== undefined && !isWalletChain(chain)) {
      res.status(400).json({ error: 'UnsupportedChain', message: 'chain must be "ethereum" or "solana" if provided' });
      return;
    }

    // Scope integrity: chain and walletAddress must be provided together or both omitted.
    if ((chain === undefined) !== (walletAddress === undefined)) {
      res.status(400).json({
        error: 'InvalidRequest',
        message: 'chain and walletAddress must be provided together (or both omitted for global scope)',
      });
      return;
    }

    let ttl = DEFAULT_CONSENT_TTL_SEC;
    if (ttlSeconds !== undefined) {
      if (typeof ttlSeconds !== 'number' || !Number.isInteger(ttlSeconds) || ttlSeconds < MIN_CONSENT_TTL_SEC) {
        res.status(400).json({
          error: 'InvalidRequest',
          message: `ttlSeconds must be an integer >= ${MIN_CONSENT_TTL_SEC}`,
        });
        return;
      }
      if (ttlSeconds > MAX_CONSENT_TTL_SEC) {
        res.status(400).json({
          error: 'InvalidRequest',
          message: `ttlSeconds may not exceed ${MAX_CONSENT_TTL_SEC} (30 days)`,
        });
        return;
      }
      ttl = ttlSeconds;
    }

    const normalizedAddress = walletAddress
      ? (chain === 'ethereum' ? String(walletAddress).toLowerCase() : String(walletAddress))
      : undefined;

    let grant;
    try {
      grant = await grantConsent({
        userDid: req.auth!.did,
        dappOrigin,
        chain: chain as any,
        walletAddress: normalizedAddress,
        ttlSeconds: ttl,
      });
    } catch (err) {
      res.status(400).json({ error: 'InvalidRequest', message: (err as Error).message });
      return;
    }

    await auditLog('wallet.consent.grant', req.auth!.userId, req.auth!.did, {
      dappOrigin: grant.dappOrigin,
      chain: grant.chain,
      walletAddress: grant.walletAddress,
      expiresAt: grant.expiresAt,
    });

    res.status(200).json(grant);
  } catch (err) {
    console.error('Error in walletGrantConsent:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'InternalServerError', message: 'Failed to grant consent' });
    }
  }
}
