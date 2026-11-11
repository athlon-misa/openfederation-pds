/** Small encodings shared by the custody modules. */
import bs58 from 'bs58';

export function base64UrlEncode(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlDecode(text: string): Uint8Array {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
export function base32Lower(bytes: Uint8Array): string {
  let bits = 0; let value = 0; let out = '';
  for (const b of bytes) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { bits -= 5; out += B32[(value >>> bits) & 0x1f]; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 0x1f];
  return out;
}

/** Multicodec prefixes (varint) for did:key. */
const SECP256K1 = [0xe7, 0x01];
const P256 = [0x80, 0x24];

export type KeyCurve = 'secp256k1' | 'p256';

export function didKeyFor(curve: KeyCurve, compressedPublicKey: Uint8Array): string {
  if (compressedPublicKey.length !== 33) throw new Error('A did:key needs a compressed (33-byte) public key');
  const prefix = curve === 'secp256k1' ? SECP256K1 : P256;
  const bytes = new Uint8Array(prefix.length + 33);
  bytes.set(prefix); bytes.set(compressedPublicKey, prefix.length);
  return `did:key:z${bs58.encode(bytes)}`;
}

export function parseDidKey(didKey: string): { curve: KeyCurve; publicKey: Uint8Array } {
  if (!didKey.startsWith('did:key:z')) throw new Error('Not a did:key');
  const bytes = bs58.decode(didKey.slice('did:key:z'.length));
  if (bytes[0] === SECP256K1[0] && bytes[1] === SECP256K1[1]) return { curve: 'secp256k1', publicKey: bytes.slice(2) };
  if (bytes[0] === P256[0] && bytes[1] === P256[1]) return { curve: 'p256', publicKey: bytes.slice(2) };
  throw new Error('Unsupported did:key type (secp256k1 and P-256 only)');
}
