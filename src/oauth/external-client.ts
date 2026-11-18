/**
 * OAuth Client for external user login.
 *
 * Configures NodeOAuthClient from @atproto/oauth-client-node to authenticate
 * users from other ATProto PDSes (e.g., bsky.social). Uses PostgreSQL-backed
 * state and session stores (external_auth_states, external_auth_sessions).
 */

import { NodeOAuthClient } from '@atproto/oauth-client-node';
import type { NodeSavedState, NodeSavedSession, NodeSavedStateStore, NodeSavedSessionStore } from '@atproto/oauth-client-node';
import { query } from '../db/client.js';
import { config } from '../config.js';
import { getDidResolver } from '../identity/did-resolver.js';
import { resolveExternalHandle } from '../identity/external-handle-resolver.js';
import { handleForHost, localDidForHandle } from '../server/tls-check.js';

// ---------- PostgreSQL State Store ----------

class PgStateStore implements NodeSavedStateStore {
  async get(key: string): Promise<NodeSavedState | undefined> {
    const result = await query<{ state: NodeSavedState }>(
      'SELECT state FROM external_auth_states WHERE key = $1',
      [key]
    );
    return result.rows[0]?.state;
  }

  async set(key: string, value: NodeSavedState): Promise<void> {
    await query(
      `INSERT INTO external_auth_states (key, state, created_at)
       VALUES ($1, $2, CURRENT_TIMESTAMP)
       ON CONFLICT (key) DO UPDATE SET state = $2`,
      [key, JSON.stringify(value)]
    );
  }

  async del(key: string): Promise<void> {
    await query('DELETE FROM external_auth_states WHERE key = $1', [key]);
  }
}

// ---------- PostgreSQL Session Store ----------

class PgSessionStore implements NodeSavedSessionStore {
  async get(key: string): Promise<NodeSavedSession | undefined> {
    const result = await query<{ session: NodeSavedSession }>(
      'SELECT session FROM external_auth_sessions WHERE key = $1',
      [key]
    );
    return result.rows[0]?.session;
  }

  async set(key: string, value: NodeSavedSession): Promise<void> {
    await query(
      `INSERT INTO external_auth_sessions (key, session, created_at)
       VALUES ($1, $2, CURRENT_TIMESTAMP)
       ON CONFLICT (key) DO UPDATE SET session = $2`,
      [key, JSON.stringify(value)]
    );
  }

  async del(key: string): Promise<void> {
    await query('DELETE FROM external_auth_sessions WHERE key = $1', [key]);
  }
}

// ---------- Identity resolution ----------

/**
 * Handle → DID for sign-in. A name under this server's own handle domain is
 * answered from this server's database, which is authoritative for it: it
 * works before (or without) the wildcard DNS that makes those names
 * resolvable elsewhere. Anything else goes through DNS TXT and
 * https://<handle>/.well-known/atproto-did with the SSRF guards of
 * resolveExternalHandle.
 */
export async function resolveSignInHandle(handle: string): Promise<string | null> {
  const bare = handleForHost(handle);
  if (bare) {
    const local = await localDidForHandle(bare);
    if (local) return local;
  }
  return resolveExternalHandle(handle.trim().toLowerCase());
}

const signInHandleResolver = {
  async resolve(handle: string): Promise<`did:${string}:${string}` | null> {
    const did = await resolveSignInHandle(handle);
    return did && /^did:[a-z]+:.+/.test(did) ? (did as `did:${string}:${string}`) : null;
  },
};

/**
 * DID → document through every directory in PLC_RESOLVER_URLS (and did:web),
 * shared and cached with service-auth (src/identity/did-resolver.ts). Without
 * it the OAuth client asks plc.directory only and cannot sign in an account
 * whose DID lives in this server's own directory.
 */
const signInDidResolver = {
  async resolve(did: string, options?: { noCache?: boolean }) {
    const doc = await getDidResolver().resolve(did, options?.noCache ?? false);
    if (!doc) throw new Error(`DID not found in any configured PLC directory: ${did}`);
    return doc;
  },
};

// ---------- Client Singleton ----------

let oauthClient: NodeOAuthClient | null = null;

export function createExternalOAuthClient(): NodeOAuthClient {
  const clientId = `${config.pds.serviceUrl}/oauth/client-metadata.json`;

  oauthClient = new NodeOAuthClient({
    clientMetadata: {
      client_id: clientId,
      client_name: 'OpenFederation PDS',
      client_uri: config.pds.serviceUrl,
      redirect_uris: [`${config.pds.serviceUrl}/oauth/external/callback`],
      scope: 'atproto transition:generic',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      application_type: 'web',
      dpop_bound_access_tokens: true,
    },
    stateStore: new PgStateStore(),
    sessionStore: new PgSessionStore(),
    // The library's own types for these are branded (Did, DidDocument);
    // ours return the same shapes, validated by @atproto/identity.
    handleResolver: signInHandleResolver as never,
    didResolver: signInDidResolver as never,
    allowHttp: !config.env.isProduction,
  });

  return oauthClient;
}

export function getExternalOAuthClient(): NodeOAuthClient | null {
  return oauthClient;
}

/**
 * Returns the OAuth client metadata document for this PDS.
 * Served at /oauth/client-metadata.json so remote PDSes can fetch it.
 */
export function getClientMetadata() {
  return {
    client_id: `${config.pds.serviceUrl}/oauth/client-metadata.json`,
    client_name: 'OpenFederation PDS',
    client_uri: config.pds.serviceUrl,
    redirect_uris: [`${config.pds.serviceUrl}/oauth/external/callback`],
    scope: 'atproto transition:generic',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    application_type: 'web',
    dpop_bound_access_tokens: true,
  };
}
