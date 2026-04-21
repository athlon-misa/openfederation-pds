/**
 * Passphrase-based encryption for wallet mnemonics using WebCrypto.
 *
 * Output format (all base64): `{ v, salt, iv, ct }` where
 *   v    — format version ("1")
 *   salt — 16 bytes for PBKDF2
 *   iv   — 12 bytes for AES-GCM
 *   ct   — ciphertext + 16-byte GCM auth tag concatenated
 *
 * PBKDF2-SHA256 at 600,000 iterations (OWASP 2023 recommendation for AES-256).
 */

const PBKDF2_ITERATIONS = 600_000;

export interface WrappedBlob {
  v: '1';
  salt: string;
  iv: string;
  ct: string;
}

function getSubtle(): SubtleCrypto {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error('WebCrypto SubtleCrypto unavailable — this API requires a secure browser context or Node ≥ 19');
  return s;
}

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  globalThis.crypto.getRandomValues(out);
  return out;
}

// WebCrypto types distinguish Uint8Array<ArrayBuffer> from the bare
// Uint8Array<ArrayBufferLike>. The `as BufferSource` casts below are safe
// because we always allocate fresh ArrayBuffer-backed arrays via randomBytes
// / TextEncoder / atob.

async function deriveWrappingKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const subtle = getSubtle();
  const passBytes = new TextEncoder().encode(passphrase);
  const base = await subtle.importKey('raw', passBytes as BufferSource, { name: 'PBKDF2' }, false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

export async function wrapMnemonic(mnemonic: string, passphrase: string): Promise<WrappedBlob> {
  if (!mnemonic) throw new Error('mnemonic is required');
  if (!passphrase) throw new Error('passphrase is required');
  const subtle = getSubtle();

  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await deriveWrappingKey(passphrase, salt);
  const plaintext = new TextEncoder().encode(mnemonic);
  const ct = new Uint8Array(
    await subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, plaintext as BufferSource)
  );

  return {
    v: '1',
    salt: toB64(salt),
    iv: toB64(iv),
    ct: toB64(ct),
  };
}

export async function unwrapMnemonic(blob: WrappedBlob, passphrase: string): Promise<string> {
  if (blob.v !== '1') throw new Error(`Unsupported wrapped blob version: ${blob.v}`);
  const subtle = getSubtle();
  const salt = fromB64(blob.salt);
  const iv = fromB64(blob.iv);
  const ct = fromB64(blob.ct);
  const key = await deriveWrappingKey(passphrase, salt);
  try {
    const pt = await subtle.decrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, ct as BufferSource);
    return new TextDecoder().decode(pt);
  } catch {
    throw new Error('Wrong passphrase or corrupted blob');
  }
}

function toB64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromB64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
