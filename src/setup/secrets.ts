/**
 * The secrets a server needs, generated (never typed) by the setup wizard.
 *
 *  AUTH_JWT_SECRET        signs session tokens; 64 hex characters (256 bits)
 *  KEY_ENCRYPTION_SECRET  encrypts recovery and signing keys at rest
 *  OAUTH_SIGNING_KEY      ES256 private key, one-line JWK (same shape as the
 *                         command in production-checks.ts prints)
 *  OAUTH_DPOP_SECRET      DPoP nonce secret, 32 bytes as hex (oauth-setup.ts
 *                         reads it with Buffer.from(…, 'hex'))
 */
import { generateKeyPairSync, randomBytes } from 'node:crypto';

export interface GeneratedSecrets {
  AUTH_JWT_SECRET: string;
  KEY_ENCRYPTION_SECRET: string;
  OAUTH_SIGNING_KEY: string;
  OAUTH_DPOP_SECRET: string;
}

export function generateOAuthSigningKey(): string {
  const jwk = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'jwk' });
  return JSON.stringify({ ...jwk, alg: 'ES256', kid: 'oauth-signing-key' });
}

export function generateSecrets(): GeneratedSecrets {
  return {
    AUTH_JWT_SECRET: randomBytes(32).toString('hex'),
    KEY_ENCRYPTION_SECRET: randomBytes(32).toString('hex'),
    OAUTH_SIGNING_KEY: generateOAuthSigningKey(),
    OAUTH_DPOP_SECRET: randomBytes(32).toString('hex'),
  };
}
