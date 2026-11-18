/**
 * Apps registered to sign people in through this server (ADR-005, decision 3).
 *
 * Registered by an admin only. The secret is 32 random bytes, returned once
 * and stored as its SHA-256; redirect URIs match exactly.
 */
import crypto from 'crypto';
import { query } from '../db/client.js';
import { SUPPORTED_SCOPES } from './claims.js';

export interface OidcClient {
  clientId: string;
  name: string;
  redirectUris: string[];
  scopes: string[];
  communityDid: string | null;
  preset: string | null;
  appUrl: string | null;
  createdBy: string | null;
  createdAt: string;
  secretRotatedAt: string | null;
}

interface ClientRow {
  client_id: string;
  name: string;
  redirect_uris: string[];
  scopes: string[];
  community_did: string | null;
  preset: string | null;
  app_url: string | null;
  created_by: string | null;
  created_at: string;
  secret_rotated_at: string | null;
}

function fromRow(r: ClientRow): OidcClient {
  return {
    clientId: r.client_id,
    name: r.name,
    redirectUris: r.redirect_uris,
    scopes: r.scopes,
    communityDid: r.community_did,
    preset: r.preset,
    appUrl: r.app_url,
    createdBy: r.created_by,
    createdAt: new Date(r.created_at).toISOString(),
    secretRotatedAt: r.secret_rotated_at ? new Date(r.secret_rotated_at).toISOString() : null,
  };
}

/** The API shape: fields that are not set are left out (lexicon strings are never null). */
export function clientView(c: OidcClient): Record<string, unknown> {
  return Object.fromEntries(Object.entries(c).filter(([, v]) => v !== null && v !== undefined));
}

const COLUMNS = 'client_id, name, redirect_uris, scopes, community_did, preset, app_url, created_by, created_at, secret_rotated_at';

export class OidcClientError extends Error {
  constructor(readonly code: 'InvalidRequest' | 'Conflict' | 'NotFound', message: string) {
    super(message);
  }
}

const CLIENT_ID_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;

function hashSecret(secret: string): string {
  return crypto.createHash('sha256').update(secret, 'utf-8').digest('hex');
}

function newSecret(): string {
  return crypto.randomBytes(32).toString('base64url');
}

/**
 * A redirect URI an app may use: absolute https (http only for loopback
 * addresses, where a developer runs the app), no fragment, no credentials.
 */
export function validateRedirectUri(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new OidcClientError('InvalidRequest', `Redirect URI "${raw}" is not a URL`);
  }
  const loopback = url.hostname === '127.0.0.1' || url.hostname === '[::1]' || url.hostname === 'localhost';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new OidcClientError('InvalidRequest', `Redirect URI "${raw}" must use https (http only for 127.0.0.1 / localhost)`);
  }
  if (url.hash || url.username || url.password) {
    throw new OidcClientError('InvalidRequest', `Redirect URI "${raw}" must not have a fragment or credentials`);
  }
  return url.toString();
}

export interface CreateClientInput {
  clientId?: string;
  name: string;
  redirectUris: string[];
  scopes?: string[];
  communityDid?: string | null;
  preset?: string | null;
  appUrl?: string | null;
  createdBy: string | null;
}

export async function createClient(input: CreateClientInput): Promise<{ client: OidcClient; clientSecret: string }> {
  const name = input.name?.trim();
  if (!name || name.length > 100) throw new OidcClientError('InvalidRequest', 'name is required (at most 100 characters)');
  if (!Array.isArray(input.redirectUris) || input.redirectUris.length === 0 || input.redirectUris.length > 10) {
    throw new OidcClientError('InvalidRequest', 'Give between 1 and 10 redirect URIs');
  }
  const redirectUris = [...new Set(input.redirectUris.map(validateRedirectUri))];
  const scopes = input.scopes && input.scopes.length > 0 ? [...new Set(input.scopes)] : ['openid', 'profile'];
  for (const s of scopes) {
    if (!(SUPPORTED_SCOPES as readonly string[]).includes(s)) {
      throw new OidcClientError('InvalidRequest', `Unsupported scope "${s}" (supported: ${SUPPORTED_SCOPES.join(', ')})`);
    }
  }
  if (!scopes.includes('openid')) scopes.unshift('openid');

  const clientId = input.clientId?.trim().toLowerCase()
    || `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'app'}-${crypto.randomBytes(3).toString('hex')}`;
  if (!CLIENT_ID_RE.test(clientId)) {
    throw new OidcClientError('InvalidRequest', 'clientId: 2–63 lowercase letters, digits and dashes, starting with a letter or digit');
  }

  let communityDid: string | null = null;
  if (input.communityDid) {
    const c = await query<{ did: string }>('SELECT did FROM communities WHERE did = $1', [input.communityDid]);
    if (!c.rows[0]) throw new OidcClientError('NotFound', 'Community not found');
    communityDid = c.rows[0].did;
  }

  const clientSecret = newSecret();
  const inserted = await query<ClientRow>(
    `INSERT INTO oidc_clients (client_id, name, secret_hash, redirect_uris, scopes, community_did, preset, app_url, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (client_id) DO NOTHING
     RETURNING ${COLUMNS}`,
    [clientId, name, hashSecret(clientSecret), redirectUris, scopes, communityDid,
      input.preset ?? null, input.appUrl ?? null, input.createdBy],
  );
  if (!inserted.rows[0]) throw new OidcClientError('Conflict', `A client "${clientId}" already exists`);
  return { client: fromRow(inserted.rows[0]), clientSecret };
}

export async function getClient(clientId: string): Promise<OidcClient | null> {
  const r = await query<ClientRow>(`SELECT ${COLUMNS} FROM oidc_clients WHERE client_id = $1`, [clientId]);
  return r.rows[0] ? fromRow(r.rows[0]) : null;
}

export async function listClients(): Promise<OidcClient[]> {
  const r = await query<ClientRow>(`SELECT ${COLUMNS} FROM oidc_clients ORDER BY created_at ASC`);
  return r.rows.map(fromRow);
}

export async function deleteClient(clientId: string): Promise<boolean> {
  const r = await query('DELETE FROM oidc_clients WHERE client_id = $1', [clientId]);
  return (r.rowCount ?? 0) > 0;
}

export async function rotateClientSecret(clientId: string): Promise<string | null> {
  const secret = newSecret();
  const r = await query(
    'UPDATE oidc_clients SET secret_hash = $2, secret_rotated_at = NOW() WHERE client_id = $1',
    [clientId, hashSecret(secret)],
  );
  return (r.rowCount ?? 0) > 0 ? secret : null;
}

/** Check a client's credentials in constant time; the client when they match. */
export async function authenticateClient(clientId: string, secret: string): Promise<OidcClient | null> {
  const r = await query<ClientRow & { secret_hash: string }>(
    `SELECT ${COLUMNS}, secret_hash FROM oidc_clients WHERE client_id = $1`,
    [clientId],
  );
  const row = r.rows[0];
  // Hash anyway when there is no such client, so timing does not tell.
  const given = Buffer.from(hashSecret(secret), 'hex');
  const stored = Buffer.from(row?.secret_hash ?? '0'.repeat(64), 'hex');
  const ok = crypto.timingSafeEqual(given, stored);
  return row && ok ? fromRow(row) : null;
}
