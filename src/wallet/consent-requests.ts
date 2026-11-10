/**
 * Consent requests: how a dApp gets permission to have this PDS sign with a
 * custodial wallet.
 *
 * A dApp holding the user's session token used to be able to create a consent
 * for its own origin with one API call, so the "consent" was never the user's.
 * Now the dApp only *asks*: it creates a request naming what it wants (which
 * wallet, which contracts, how much value, for how long) and sends the user to
 * a page this PDS serves. The user reads what is being asked and approves it
 * there with their account password. Only then does the consent exist.
 *
 * The page is on the PDS's own origin and cannot be framed, so the dApp's
 * script can neither read it nor click it; approval is checked against the
 * password, and the approving request must come from that page's origin.
 */
import { query, withTransaction } from '../db/client.js';
import { config } from '../config.js';
import { grantConsent, normalizeDappOrigin, CONSENT_REQUEST_TTL_SEC, type ConsentGrant } from './consent.js';
import type { ConsentScope } from './consent-scope.js';
import type { WalletChain } from './types.js';

export interface ConsentRequest {
  id: string;
  userDid: string;
  dappOrigin: string;
  chain: WalletChain | null;
  walletAddress: string | null;
  scope: ConsentScope;
  ttlSeconds: number;
  status: 'pending' | 'approved' | 'denied';
  consentId: string | null;
  createdAt: string;
  expiresAt: string;
  expired: boolean;
}

interface RequestRow {
  id: string; user_did: string; dapp_origin: string; chain: string | null; wallet_address: string | null;
  allowed_contracts: string[] | null; max_value_per_tx: string | null; max_total_value: string | null;
  ttl_seconds: number; status: 'pending' | 'approved' | 'denied'; consent_id: string | null;
  created_at: Date; expires_at: Date; expired: boolean;
}

function fromRow(row: RequestRow): ConsentRequest {
  return {
    id: row.id,
    userDid: row.user_did,
    dappOrigin: row.dapp_origin,
    chain: row.chain as WalletChain | null,
    walletAddress: row.wallet_address,
    scope: {
      allowedContracts: Array.isArray(row.allowed_contracts) ? row.allowed_contracts : null,
      maxValuePerTx: row.max_value_per_tx === null ? null : BigInt(row.max_value_per_tx),
      maxTotalValue: row.max_total_value === null ? null : BigInt(row.max_total_value),
    },
    ttlSeconds: row.ttl_seconds,
    status: row.status,
    consentId: row.consent_id,
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    expired: row.expired,
  };
}

const COLUMNS = `id, user_did, dapp_origin, chain, wallet_address, allowed_contracts, max_value_per_tx,
  max_total_value, ttl_seconds, status, consent_id, created_at, expires_at, (expires_at <= NOW()) AS expired`;

/** Where the user approves a request: a page on this PDS. */
export function consentApprovalUrl(requestId: string): string {
  return `${config.pds.serviceUrl.replace(/\/+$/, '')}/wallet/consent/${requestId}`;
}

export async function createConsentRequest(opts: {
  userDid: string;
  dappOrigin: string;
  chain?: WalletChain;
  walletAddress?: string;
  scope: ConsentScope;
  ttlSeconds: number;
}): Promise<ConsentRequest> {
  const result = await query<RequestRow>(
    `INSERT INTO wallet_consent_requests
       (user_did, dapp_origin, chain, wallet_address, allowed_contracts, max_value_per_tx, max_total_value, ttl_seconds, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW() + ($9::int * INTERVAL '1 second'))
     RETURNING ${COLUMNS}`,
    [
      opts.userDid, normalizeDappOrigin(opts.dappOrigin), opts.chain ?? null, opts.walletAddress ?? null,
      opts.scope.allowedContracts ? JSON.stringify(opts.scope.allowedContracts) : null,
      opts.scope.maxValuePerTx?.toString() ?? null, opts.scope.maxTotalValue?.toString() ?? null,
      opts.ttlSeconds, CONSENT_REQUEST_TTL_SEC,
    ],
  );
  return fromRow(result.rows[0]);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function getConsentRequest(requestId: string): Promise<ConsentRequest | null> {
  if (!UUID.test(requestId)) return null;
  const result = await query<RequestRow>(`SELECT ${COLUMNS} FROM wallet_consent_requests WHERE id = $1`, [requestId]);
  return result.rows[0] ? fromRow(result.rows[0]) : null;
}

export class ConsentRequestError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
    this.name = 'ConsentRequestError';
  }
}

/**
 * Settle a pending request: approve it (creating the consent it asked for)
 * or deny it. The caller has already confirmed the user is present. A request
 * is settled once; a lapsed one cannot be.
 */
export async function settleConsentRequest(requestId: string, approve: boolean): Promise<{ request: ConsentRequest; consent: ConsentGrant | null }> {
  return withTransaction(async (client) => {
    const locked = await client.query<RequestRow>(
      `SELECT ${COLUMNS} FROM wallet_consent_requests WHERE id = $1 FOR UPDATE`, [requestId]);
    const row = locked.rows[0];
    if (!row) throw new ConsentRequestError(404, 'NotFound', 'No such consent request');
    if (row.status !== 'pending') throw new ConsentRequestError(409, 'AlreadySettled', `This request was already ${row.status}`);
    if (row.expired) throw new ConsentRequestError(410, 'Expired', 'This request has expired; ask the app to make a new one');
    const request = fromRow(row);

    if (!approve) {
      await client.query(`UPDATE wallet_consent_requests SET status = 'denied' WHERE id = $1`, [requestId]);
      return { request: { ...request, status: 'denied' }, consent: null };
    }
    const consent = await grantConsent({
      userDid: request.userDid,
      dappOrigin: request.dappOrigin,
      chain: request.chain ?? undefined,
      walletAddress: request.walletAddress ?? undefined,
      ttlSeconds: request.ttlSeconds,
      scope: request.scope,
      client,
    });
    await client.query(
      `UPDATE wallet_consent_requests SET status = 'approved', consent_id = $2 WHERE id = $1`, [requestId, consent.id]);
    return { request: { ...request, status: 'approved', consentId: consent.id }, consent };
  });
}
