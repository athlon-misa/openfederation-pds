/**
 * The provider's signing key (ADR-005, decision 8).
 *
 * RS256, the one algorithm every OpenID Connect client must support. Made on
 * first use and kept in `oidc_signing_keys`, the private half encrypted with
 * KEY_ENCRYPTION_SECRET like every other key this server holds, so ID tokens
 * stay verifiable across restarts and replicas.
 */
import crypto from 'crypto';
import { query } from '../db/client.js';
import { encryptKeyBytes, decryptKeyBytes } from '../auth/encryption.js';

export interface OidcSigningKey {
  kid: string;
  privateKey: crypto.KeyObject;
  publicKey: crypto.KeyObject;
  publicJwk: Record<string, unknown>;
}

let cached: OidcSigningKey | null = null;
let pending: Promise<OidcSigningKey> | null = null;

/** Forget the decrypted key (tests, the demo reset). */
export function clearOidcKeyCache(): void {
  cached = null;
  pending = null;
}

function fromRow(kid: string, publicJwk: Record<string, unknown>, privatePem: string): OidcSigningKey {
  const privateKey = crypto.createPrivateKey(privatePem);
  return { kid, privateKey, publicKey: crypto.createPublicKey(privateKey), publicJwk };
}

async function load(): Promise<OidcSigningKey> {
  const existing = await query<{ kid: string; public_jwk: Record<string, unknown>; encrypted_private_key: Buffer }>(
    'SELECT kid, public_jwk, encrypted_private_key FROM oidc_signing_keys ORDER BY created_at ASC LIMIT 1',
  );
  if (existing.rows[0]) {
    const row = existing.rows[0];
    const pem = (await decryptKeyBytes(row.encrypted_private_key, 'oidc.signing-key')).toString('utf-8');
    return fromRow(row.kid, row.public_jwk, pem);
  }

  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
  // RFC 7638 thumbprint as the key id.
  const thumb = crypto.createHash('sha256')
    .update(JSON.stringify({ e: jwk.e, kty: jwk.kty, n: jwk.n }))
    .digest('base64url');
  const publicJwk = { ...jwk, kid: thumb, alg: 'RS256', use: 'sig' };
  const pem = privateKey.export({ format: 'pem', type: 'pkcs8' }) as string;
  const encrypted = await encryptKeyBytes(Buffer.from(pem, 'utf-8'), 'oidc.signing-key');
  await query(
    `INSERT INTO oidc_signing_keys (kid, public_jwk, encrypted_private_key) VALUES ($1, $2, $3)
     ON CONFLICT (kid) DO NOTHING`,
    [thumb, JSON.stringify(publicJwk), encrypted],
  );
  // Two replicas starting at once may both have made one: use whichever is oldest.
  const winner = await query<{ kid: string; public_jwk: Record<string, unknown>; encrypted_private_key: Buffer }>(
    'SELECT kid, public_jwk, encrypted_private_key FROM oidc_signing_keys ORDER BY created_at ASC LIMIT 1',
  );
  const row = winner.rows[0];
  const winnerPem = (await decryptKeyBytes(row.encrypted_private_key, 'oidc.signing-key')).toString('utf-8');
  return fromRow(row.kid, row.public_jwk, winnerPem);
}

export async function getOidcSigningKey(): Promise<OidcSigningKey> {
  if (cached) return cached;
  if (!pending) {
    pending = load().then((key) => { cached = key; return key; }).finally(() => { pending = null; });
  }
  return pending;
}
