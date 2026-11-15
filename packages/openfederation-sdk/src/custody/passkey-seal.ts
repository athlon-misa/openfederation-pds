/**
 * Sealing a secret on the device with a passkey's WebAuthn PRF output
 * (AES-256-GCM, key from HKDF-SHA256 over the PRF output). Shared by the
 * remembered phrase (decision 12, device-unlock.ts) and the remembered device
 * repo key (#240, device-key-store.ts); each passes its own labels, so a blob
 * of one kind never opens as the other. Internal: not exported from the
 * custody entry point.
 */
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha2';
import { utf8ToBytes } from '@noble/hashes/utils';
import { base64UrlDecode, base64UrlEncode } from './encoding.js';

export type Credentials = Pick<CredentialsContainer, 'create' | 'get'>;

/** What the sealed blob is, so one kind of blob never opens as another. */
export interface SealLabels {
  /** HKDF salt. */
  salt: string;
  /** Additional authenticated data, bound to the credential (and anything else the caller names). */
  aad: (credentialId: string) => string;
}

export interface SealedWithPasskey {
  credentialId: string;
  prfSalt: string;
  iv: string;
  ciphertext: string;
}

export function credentialsOf(c?: Credentials): Credentials {
  const found = c ?? (globalThis.navigator?.credentials as Credentials | undefined);
  if (!found) throw new Error('PasskeyPrfUnsupported');
  return found;
}

function random(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

async function aesKey(prfOutput: Uint8Array, labels: SealLabels): Promise<CryptoKey> {
  const raw = hkdf(sha256, prfOutput, utf8ToBytes(labels.salt), utf8ToBytes('aes-256-gcm-v1'), 32);
  return crypto.subtle.importKey('raw', raw as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/**
 * The PRF output as bytes, or null when there is none worth using. Browsers
 * return an ArrayBuffer; password-manager extensions do not always: 1Password
 * returns a plain array of numbers. Anything shorter than 32 bytes (a PRF
 * output's length) is refused, never padded: a key derived from no bytes is
 * the same for everyone and protects nothing.
 */
function prfFirst(cred: PublicKeyCredential): Uint8Array | null {
  const prf = (cred.getClientExtensionResults() as { prf?: { results?: { first?: unknown } } }).prf;
  const first = prf?.results?.first;
  let bytes: Uint8Array | null = null;
  if (first instanceof ArrayBuffer || Object.prototype.toString.call(first) === '[object ArrayBuffer]') {
    bytes = new Uint8Array(first as ArrayBuffer);
  } else if (ArrayBuffer.isView(first)) {
    bytes = new Uint8Array(first.buffer, first.byteOffset, first.byteLength);
  } else if (Array.isArray(first) && first.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) {
    bytes = Uint8Array.from(first as number[]);
  }
  return bytes && bytes.length >= 32 ? bytes : null;
}

async function evaluatePrf(credentials: Credentials, credentialId: Uint8Array, salt: Uint8Array, rpId?: string): Promise<Uint8Array> {
  const cred = await credentials.get({
    publicKey: {
      challenge: random(32) as BufferSource,
      rpId,
      allowCredentials: [{ type: 'public-key', id: credentialId as BufferSource }],
      userVerification: 'required',
      extensions: { prf: { eval: { first: salt as BufferSource } } } as AuthenticationExtensionsClientInputs,
    },
  }) as PublicKeyCredential | null;
  if (!cred) throw new Error('PasskeyCancelled');
  const out = prfFirst(cred);
  if (!out) throw new Error('PasskeyPrfUnsupported');
  return out;
}

/** Create a passkey with the PRF extension; returns its credential id bytes. */
async function createPrfPasskey(credentials: Credentials, p: { rpName: string; userName: string; rpId?: string }, salt: Uint8Array): Promise<Uint8Array> {
  const created = await credentials.create({
    publicKey: {
      challenge: random(32) as BufferSource,
      rp: { name: p.rpName, ...(p.rpId ? { id: p.rpId } : {}) },
      user: { id: random(16) as BufferSource, name: p.userName, displayName: p.userName },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { userVerification: 'required', residentKey: 'preferred' },
      extensions: { prf: { eval: { first: salt as BufferSource } } } as AuthenticationExtensionsClientInputs,
    },
  }) as PublicKeyCredential | null;
  if (!created) throw new Error('PasskeyCancelled');
  const ext = (created.getClientExtensionResults() as { prf?: { enabled?: boolean } }).prf;
  if (ext?.enabled === false) throw new Error('PasskeyPrfUnsupported');
  return new Uint8Array(created.rawId);
}

/**
 * Seal `plaintext` with a passkey: a new one (Touch ID or similar twice: to
 * create it, then to sign in with it), or the existing `credentialId` (once).
 * The key always comes from a sign-in, as it will when opening: some
 * authenticators answer PRF at creation from a different secret than at
 * sign-in (CTAP hmac-secret keeps one without and one with user
 * verification), and a secret sealed with that answer never opens.
 */
export async function sealWithPasskey(p: {
  plaintext: Uint8Array;
  labels: SealLabels;
  rpName: string;
  userName: string;
  rpId?: string;
  credentials?: Credentials;
  credentialId?: string;
}): Promise<SealedWithPasskey> {
  const credentials = credentialsOf(p.credentials);
  const salt = random(32);
  const credentialIdBytes = p.credentialId ? base64UrlDecode(p.credentialId) : await createPrfPasskey(credentials, p, salt);
  const credentialId = base64UrlEncode(credentialIdBytes);
  const prf = await evaluatePrf(credentials, credentialIdBytes, salt, p.rpId);
  const iv = random(12);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource, additionalData: utf8ToBytes(p.labels.aad(credentialId)) as BufferSource },
    await aesKey(prf, p.labels), p.plaintext as BufferSource));
  return { credentialId, prfSalt: base64UrlEncode(salt), iv: base64UrlEncode(iv), ciphertext: base64UrlEncode(ciphertext) };
}

/** Open a sealed blob with its passkey. Throws `UnlockFailed` if the passkey or data don't match. */
export async function openWithPasskey(stored: SealedWithPasskey, labels: SealLabels, opts: { rpId?: string; credentials?: Credentials } = {}): Promise<Uint8Array> {
  const prf = await evaluatePrf(credentialsOf(opts.credentials), base64UrlDecode(stored.credentialId), base64UrlDecode(stored.prfSalt), opts.rpId);
  try {
    return new Uint8Array(await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: base64UrlDecode(stored.iv) as BufferSource, additionalData: utf8ToBytes(labels.aad(stored.credentialId)) as BufferSource },
      await aesKey(prf, labels), base64UrlDecode(stored.ciphertext) as BufferSource));
  } catch {
    throw new Error('UnlockFailed');
  }
}
