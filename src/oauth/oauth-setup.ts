/**
 * OAuth Provider initialization.
 *
 * Creates and configures the @atproto/oauth-provider instance
 * with PostgreSQL-backed stores and ES256 signing keys.
 */

import { OAuthProvider, JoseKey } from '@atproto/oauth-provider';
import type { LexiconStore, LexiconData } from '@atproto/oauth-provider';
import { config } from '../config.js';
import { PgAccountStore, PgRequestStore, PgDeviceStore, PgTokenStore } from './oauth-store.js';

// In-memory LexiconStore — stores client lexicon documents.
// Required by OAuthProvider but not critical for basic OAuth flows.
class MemoryLexiconStore implements LexiconStore {
  private store = new Map<string, LexiconData>();
  async findLexicon(nsid: string): Promise<LexiconData | null> {
    return this.store.get(nsid) ?? null;
  }
  async storeLexicon(nsid: string, data: LexiconData): Promise<void> {
    this.store.set(nsid, data);
  }
  async deleteLexicon(nsid: string): Promise<void> {
    this.store.delete(nsid);
  }
}

let oauthProvider: OAuthProvider | null = null;

export async function createOAuthProvider(): Promise<OAuthProvider> {
  // Generate or load ES256 signing key for OAuth tokens
  let signingKey: JoseKey;
  if (config.oauth.signingKey) {
    // Load from env (production)
    signingKey = await JoseKey.fromJWK(config.oauth.signingKey);
  } else {
    // Auto-generate for development
    console.log('OAuth: Auto-generating ES256 signing key (set OAUTH_SIGNING_KEY for production)');
    signingKey = await JoseKey.generate(['ES256'], 'oauth-signing-key');
  }

  const issuer = config.pds.serviceUrl;

  const providerOptions: ConstructorParameters<typeof OAuthProvider>[0] = {
    issuer,
    keyset: [signingKey],

    // Individual stores backed by PostgreSQL
    accountStore: new PgAccountStore(),
    requestStore: new PgRequestStore(),
    deviceStore: new PgDeviceStore(),
    tokenStore: new PgTokenStore(),
    lexiconStore: new MemoryLexiconStore(),

    // Redis for replay protection (falls back to memory if not configured)
    ...(config.oauth.redisUrl ? { redis: config.oauth.redisUrl } : {}),

    // DPoP configuration
    ...(config.oauth.dpopSecret ? { dpopSecret: Buffer.from(config.oauth.dpopSecret, 'hex') } : {}),

    // Metadata additions
    metadata: {
      protected_resources: [new URL(issuer).origin],
    },

    // Client info hook
    getClientInfo: (clientId) => {
      const isTrusted = config.oauth.trustedClients.includes(clientId);
      return isTrusted ? { isTrusted: true } : undefined;
    },

    // Hooks for audit logging
    onSignedIn: async ({ account, deviceMetadata }) => {
      console.log(`OAuth sign-in: ${account.sub} from ${deviceMetadata.ipAddress}`);
    },
    onAuthorized: async ({ client, account }) => {
      console.log(`OAuth authorized: ${account.sub} for client ${client.id}`);
    },
  };

  oauthProvider = new OAuthProvider(providerOptions);
  return oauthProvider;
}

export function getOAuthProvider(): OAuthProvider | null {
  return oauthProvider;
}
