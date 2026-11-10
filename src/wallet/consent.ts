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

import type { PoolClient } from 'pg';
import { query } from '../db/client.js';
import { config } from '../config.js';
import type { ConsentScope } from './consent-scope.js';
import type { WalletChain } from './types.js';

export const DEFAULT_CONSENT_TTL_SEC = 60 * 60;             // 1 hour
/** Longest a consent may last: WALLET_CONSENT_MAX_HOURS, default 24. */
export const MAX_CONSENT_TTL_SEC = config.wallet.maxConsentHours * 60 * 60;
export const MIN_CONSENT_TTL_SEC = 60;                      // 1 minute
/** How long a consent request waits for the user before it lapses. */
export const CONSENT_REQUEST_TTL_SEC = 10 * 60;

export interface ConsentGrant {
  id: string;
  dappOrigin: string;
  chain: WalletChain | null;
  walletAddress: string | null;
  allowedContracts: string[] | null;
  maxValuePerTx: string | null;
  maxTotalValue: string | null;
  spentValue: string;
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

/**
 * Record a consent. Only called once the user has approved a consent
 * request on the PDS's own page (`approveConsentRequest`); there is no
 * endpoint that lets a dApp create one directly.
 */
export async function grantConsent(opts: {
  userDid: string;
  dappOrigin: string;
  chain?: WalletChain;
  walletAddress?: string;
  ttlSeconds?: number;
  scope?: ConsentScope;
  client?: PoolClient;
}): Promise<ConsentGrant> {
  const run = opts.client ? opts.client.query.bind(opts.client) : query;
  const origin = normalizeDappOrigin(opts.dappOrigin);
  let ttl = opts.ttlSeconds ?? DEFAULT_CONSENT_TTL_SEC;
  if (ttl < MIN_CONSENT_TTL_SEC) ttl = MIN_CONSENT_TTL_SEC;
  if (ttl > MAX_CONSENT_TTL_SEC) ttl = MAX_CONSENT_TTL_SEC;

  const expiresAt = new Date(Date.now() + ttl * 1000);

  // Mark any previous unexpired consent for the same (user, origin, wallet)
  // scope as revoked so the latest grant is the only active one.
  await run(
    `UPDATE wallet_dapp_consents
       SET revoked_at = NOW()
     WHERE user_did = $1 AND dapp_origin = $2
       AND chain IS NOT DISTINCT FROM $3
       AND wallet_address IS NOT DISTINCT FROM $4
       AND revoked_at IS NULL`,
    [opts.userDid, origin, opts.chain ?? null, opts.walletAddress ?? null]
  );

  const scope = opts.scope ?? { allowedContracts: null, maxValuePerTx: null, maxTotalValue: null };
  const result = await run(
    `INSERT INTO wallet_dapp_consents
       (user_did, dapp_origin, chain, wallet_address, expires_at, allowed_contracts, max_value_per_tx, max_total_value)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, granted_at, expires_at`,
    [opts.userDid, origin, opts.chain ?? null, opts.walletAddress ?? null, expiresAt,
     scope.allowedContracts ? JSON.stringify(scope.allowedContracts) : null,
     scope.maxValuePerTx?.toString() ?? null, scope.maxTotalValue?.toString() ?? null]
  ) as { rows: Array<{ id: string; granted_at: Date; expires_at: Date }> };

  const row = result.rows[0];
  return {
    id: row.id,
    dappOrigin: origin,
    chain: (opts.chain ?? null) as WalletChain | null,
    walletAddress: opts.walletAddress ?? null,
    allowedContracts: scope.allowedContracts,
    maxValuePerTx: scope.maxValuePerTx?.toString() ?? null,
    maxTotalValue: scope.maxTotalValue?.toString() ?? null,
    spentValue: '0',
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
export interface ActiveConsent {
  id: string;
  scope: ConsentScope;
}

/**
 * The consent that currently lets this dApp origin have this wallet sign,
 * with its limits, or null. A consent scoped to this exact wallet is
 * preferred over a broader all-wallets one.
 */
export async function findActiveConsent(opts: {
  userDid: string;
  dappOrigin: string;
  chain: WalletChain;
  walletAddress: string;
}): Promise<ActiveConsent | null> {
  const origin = normalizeDappOrigin(opts.dappOrigin);
  const result = await query<{
    id: string; allowed_contracts: string[] | null; max_value_per_tx: string | null; max_total_value: string | null;
  }>(
    `SELECT id, allowed_contracts, max_value_per_tx, max_total_value FROM wallet_dapp_consents
     WHERE user_did = $1
       AND dapp_origin = $2
       AND revoked_at IS NULL
       AND expires_at > NOW()
       AND (
         (chain IS NULL AND wallet_address IS NULL)
         OR (chain = $3 AND wallet_address = $4)
       )
     ORDER BY (wallet_address IS NULL) ASC, granted_at DESC
     LIMIT 1`,
    [opts.userDid, origin, opts.chain, opts.walletAddress]
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    scope: {
      allowedContracts: Array.isArray(row.allowed_contracts) ? row.allowed_contracts : null,
      maxValuePerTx: row.max_value_per_tx === null ? null : BigInt(row.max_value_per_tx),
      maxTotalValue: row.max_total_value === null ? null : BigInt(row.max_total_value),
    },
  };
}

export async function hasActiveConsent(opts: {
  userDid: string;
  dappOrigin: string;
  chain: WalletChain;
  walletAddress: string;
}): Promise<boolean> {
  return (await findActiveConsent(opts)) !== null;
}

/**
 * Count `value` against a consent's total limit, atomically. False when it
 * would take the consent over its limit (nothing is recorded then). A
 * consent without a total limit has nothing to count.
 */
export async function chargeConsent(consentId: string, value: bigint): Promise<boolean> {
  if (value === 0n) return true;
  const charged = await query(
    `UPDATE wallet_dapp_consents SET spent_value = spent_value + $2::numeric
     WHERE id = $1 AND revoked_at IS NULL AND expires_at > NOW()
       AND (max_total_value IS NULL OR spent_value + $2::numeric <= max_total_value)`,
    [consentId, value.toString()],
  );
  return charged.rowCount === 1;
}

/** Give back a charge whose signature was never produced. */
export async function refundConsent(consentId: string, value: bigint): Promise<void> {
  if (value === 0n) return;
  await query('UPDATE wallet_dapp_consents SET spent_value = GREATEST(spent_value - $2::numeric, 0) WHERE id = $1',
    [consentId, value.toString()]);
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
    allowed_contracts: string[] | null;
    max_value_per_tx: string | null;
    max_total_value: string | null;
    spent_value: string;
  }>(
    `SELECT id, dapp_origin, chain, wallet_address, granted_at, expires_at, revoked_at,
            allowed_contracts, max_value_per_tx, max_total_value, spent_value
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
    allowedContracts: Array.isArray(r.allowed_contracts) ? r.allowed_contracts : null,
    maxValuePerTx: r.max_value_per_tx,
    maxTotalValue: r.max_total_value,
    spentValue: String(r.spent_value),
    grantedAt: r.granted_at.toISOString(),
    expiresAt: r.expires_at.toISOString(),
    revokedAt: null,
  }));
}
