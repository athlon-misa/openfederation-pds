/**
 * Per-dApp consent grants for Tier 1 custodial signing.
 *
 * The PDS refuses to sign with a Tier 1 wallet unless the user has explicitly
 * granted consent to the requesting dApp origin, with an expiry. Default TTL
 * is 7 days, capped at 30. Users can revoke a consent early; expired consents
 * auto-reject without DB writes.
 *
 * Consents can scope to a single wallet (chain + address) or to all the user's
 * Tier 1 wallets. SDK-issued grants prefer per-wallet scope.
 */

import { query } from '../db/client.js';
import type { WalletChain } from './types.js';

export const DEFAULT_CONSENT_TTL_SEC = 7 * 24 * 60 * 60;   // 7 days
export const MAX_CONSENT_TTL_SEC = 30 * 24 * 60 * 60;      // 30 days
export const MIN_CONSENT_TTL_SEC = 60;                      // 1 minute

export interface ConsentGrant {
  id: string;
  dappOrigin: string;
  chain: WalletChain | null;
  walletAddress: string | null;
  grantedAt: string;
  expiresAt: string;
  revokedAt: string | null;
}

/**
 * Normalize a dApp origin so equivalent forms match. Strips trailing slashes,
 * lowercases the host. Accepts HTTPS URLs; rejects anything without a host.
 */
export function normalizeDappOrigin(raw: string): string {
  if (!raw || typeof raw !== 'string') {
    throw new Error('dApp origin is required');
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('dApp origin must be a full URL (e.g. https://example.com)');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('dApp origin must use http or https');
  }
  // Canonical form: protocol + lowercased host (url.host already contains any
  // non-default port).
  return `${url.protocol}//${url.host.toLowerCase()}`;
}

export async function grantConsent(opts: {
  userDid: string;
  dappOrigin: string;
  chain?: WalletChain;
  walletAddress?: string;
  ttlSeconds?: number;
}): Promise<ConsentGrant> {
  const origin = normalizeDappOrigin(opts.dappOrigin);
  let ttl = opts.ttlSeconds ?? DEFAULT_CONSENT_TTL_SEC;
  if (ttl < MIN_CONSENT_TTL_SEC) ttl = MIN_CONSENT_TTL_SEC;
  if (ttl > MAX_CONSENT_TTL_SEC) ttl = MAX_CONSENT_TTL_SEC;

  const expiresAt = new Date(Date.now() + ttl * 1000);

  // Mark any previous unexpired consent for the same (user, origin, wallet)
  // scope as revoked so the latest grant is the only active one.
  await query(
    `UPDATE wallet_dapp_consents
       SET revoked_at = NOW()
     WHERE user_did = $1 AND dapp_origin = $2
       AND chain IS NOT DISTINCT FROM $3
       AND wallet_address IS NOT DISTINCT FROM $4
       AND revoked_at IS NULL`,
    [opts.userDid, origin, opts.chain ?? null, opts.walletAddress ?? null]
  );

  const result = await query<{
    id: string; granted_at: Date; expires_at: Date;
  }>(
    `INSERT INTO wallet_dapp_consents
       (user_did, dapp_origin, chain, wallet_address, expires_at)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, granted_at, expires_at`,
    [opts.userDid, origin, opts.chain ?? null, opts.walletAddress ?? null, expiresAt]
  );

  const row = result.rows[0];
  return {
    id: row.id,
    dappOrigin: origin,
    chain: (opts.chain ?? null) as WalletChain | null,
    walletAddress: opts.walletAddress ?? null,
    grantedAt: row.granted_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    revokedAt: null,
  };
}

/**
 * Revoke consents matching the given scope. Returns the count revoked.
 * Either `id` or ({dappOrigin} + optional wallet scope) must be provided.
 */
export async function revokeConsent(opts: {
  userDid: string;
  id?: string;
  dappOrigin?: string;
  chain?: WalletChain;
  walletAddress?: string;
}): Promise<number> {
  if (opts.id) {
    const result = await query(
      `UPDATE wallet_dapp_consents
         SET revoked_at = NOW()
       WHERE id = $1 AND user_did = $2 AND revoked_at IS NULL`,
      [opts.id, opts.userDid]
    );
    return result.rowCount ?? 0;
  }
  if (!opts.dappOrigin) {
    throw new Error('Either id or dappOrigin is required to revoke consent');
  }
  const origin = normalizeDappOrigin(opts.dappOrigin);
  const result = await query(
    `UPDATE wallet_dapp_consents
       SET revoked_at = NOW()
     WHERE user_did = $1 AND dapp_origin = $2
       AND ($3::TEXT IS NULL OR chain = $3)
       AND ($4::TEXT IS NULL OR wallet_address = $4)
       AND revoked_at IS NULL`,
    [opts.userDid, origin, opts.chain ?? null, opts.walletAddress ?? null]
  );
  return result.rowCount ?? 0;
}

/**
 * Check whether the given (origin, wallet) tuple is currently authorized.
 * Matches an active grant that is scoped to this exact wallet OR a broader
 * grant that has `chain` and `wallet_address` both NULL (all-Tier-1 grant).
 */
export async function hasActiveConsent(opts: {
  userDid: string;
  dappOrigin: string;
  chain: WalletChain;
  walletAddress: string;
}): Promise<boolean> {
  const origin = normalizeDappOrigin(opts.dappOrigin);
  const result = await query<{ id: string }>(
    `SELECT id FROM wallet_dapp_consents
     WHERE user_did = $1
       AND dapp_origin = $2
       AND revoked_at IS NULL
       AND expires_at > NOW()
       AND (
         (chain IS NULL AND wallet_address IS NULL)
         OR (chain = $3 AND wallet_address = $4)
       )
     LIMIT 1`,
    [opts.userDid, origin, opts.chain, opts.walletAddress]
  );
  return result.rows.length > 0;
}

/**
 * List active (not revoked, not expired) consents for the user, newest first.
 */
export async function listConsents(userDid: string): Promise<ConsentGrant[]> {
  const result = await query<{
    id: string;
    dapp_origin: string;
    chain: string | null;
    wallet_address: string | null;
    granted_at: Date;
    expires_at: Date;
    revoked_at: Date | null;
  }>(
    `SELECT id, dapp_origin, chain, wallet_address, granted_at, expires_at, revoked_at
     FROM wallet_dapp_consents
     WHERE user_did = $1 AND revoked_at IS NULL AND expires_at > NOW()
     ORDER BY granted_at DESC`,
    [userDid]
  );
  return result.rows.map((r) => ({
    id: r.id,
    dappOrigin: r.dapp_origin,
    chain: r.chain as WalletChain | null,
    walletAddress: r.wallet_address,
    grantedAt: r.granted_at.toISOString(),
    expiresAt: r.expires_at.toISOString(),
    revokedAt: null,
  }));
}
