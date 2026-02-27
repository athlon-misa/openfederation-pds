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
    allowHttp: process.env.NODE_ENV !== 'production',
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
