/** An ES256K JWT signed with a raw secp256k1 private key (AT Protocol service-auth shape). */
import { secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { base64UrlEncode } from '@open-federation/pseudonym';

const json64 = (value: unknown) => base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)));

export function signJwt(privateKey: Uint8Array, claims: { iss: string; aud: string; lxm: string; sub?: string; ttlSeconds?: number }): string {
  const now = Math.floor(Date.now() / 1000);
  const header = json64({ typ: 'JWT', alg: 'ES256K' });
  const payload = json64({
    iss: claims.iss, aud: claims.aud, lxm: claims.lxm, iat: now, exp: now + (claims.ttlSeconds ?? 120),
    jti: base64UrlEncode(crypto.getRandomValues(new Uint8Array(16))),
    ...(claims.sub ? { sub: claims.sub } : {}),
  });
  const signature = secp256k1.sign(sha256(new TextEncoder().encode(`${header}.${payload}`)), privateKey, { lowS: true });
  return `${header}.${payload}.${base64UrlEncode(signature.toCompactRawBytes())}`;
}

/** A rotation key pasted as base64 (the format community.create returns), or hex. */
export function parsePrivateKey(text: string): Uint8Array {
  const t = text.trim();
  let bytes: Uint8Array;
  if (/^[0-9a-fA-F]{64}$/.test(t)) {
    bytes = Uint8Array.from(t.match(/../g)!.map((h) => parseInt(h, 16)));
  } else {
    try {
      bytes = Uint8Array.from(atob(t.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
    } catch {
      throw new Error('The rotation key is not valid base64');
    }
  }
  if (bytes.length !== 32 || !secp256k1.utils.isValidPrivateKey(bytes)) throw new Error('That is not a secp256k1 private key (32 bytes)');
  return bytes;
}
