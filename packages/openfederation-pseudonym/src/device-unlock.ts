/**
 * Daily unlock for a phrase-controlled identity: type the twelve words once on
 * a device, then unlock them with a passkey (Face ID, Touch ID, Windows Hello,
 * a security key). Issue #251.
 *
 * The phrase is encrypted with AES-256-GCM under a key derived from the
 * passkey's WebAuthn PRF output. The authenticator only releases that output
 * after user verification, so guessing is limited by its hardware, not by this
 * code. Nothing here talks to the PDS: the passkey is local, and the server
 * cannot link it to anyone.
 *
 * Without PRF support these functions throw `PasskeyPrfUnsupported`. Callers
 * keep using the phrase then, never a weaker secret.
 */
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha2';
import { utf8ToBytes } from '@noble/hashes/utils';
import { base64UrlDecode, base64UrlEncode } from './formats.js';
import { derivePseudonymKeys } from './keys.js';

/** The encrypted phrase. Safe to keep in local storage: useless without the passkey. */
export interface RememberedPhrase {
  version: 1;
  credentialId: string;
  prfSalt: string;
  iv: string;
  ciphertext: string;
}

type Credentials = Pick<CredentialsContainer, 'create' | 'get'>;

function credentialsOf(c?: Credentials): Credentials {
  const found = c ?? (globalThis.navigator?.credentials as Credentials | undefined);
  if (!found) throw new Error('PasskeyPrfUnsupported');
  return found;
}

function random(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

function aad(credentialId: string): Uint8Array {
  return utf8ToBytes(`openfederation-remembered-phrase-v1\n${credentialId}`);
}

async function aesKey(prfOutput: Uint8Array): Promise<CryptoKey> {
  const raw = hkdf(sha256, prfOutput, utf8ToBytes('openfederation-remembered-phrase'), utf8ToBytes('aes-256-gcm-v1'), 32);
  return crypto.subtle.importKey('raw', raw as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

function prfFirst(cred: PublicKeyCredential): Uint8Array | null {
  const prf = (cred.getClientExtensionResults() as { prf?: { results?: { first?: BufferSource } } }).prf;
  const first = prf?.results?.first;
  if (!first) return null;
  return first instanceof ArrayBuffer ? new Uint8Array(first) : new Uint8Array(first.buffer, first.byteOffset, first.byteLength);
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

/**
 * Create a passkey on this device and encrypt the phrase with it. Asks for
 * Touch ID (or similar) once, or twice on authenticators that only answer PRF
 * when signing in.
 *
 * `userName` is what the device's password manager shows. Synced passkeys
 * carry it to that account, so for a pseudonym pick something neutral.
 */
export async function rememberPhraseWithPasskey(p: {
  phrase: string;
  rpName: string;
  userName: string;
  rpId?: string;
  credentials?: Credentials;
}): Promise<RememberedPhrase> {
  derivePseudonymKeys(p.phrase); // refuse to store a phrase that isn't valid
  const phrase = p.phrase.trim().toLowerCase().split(/\s+/).join(' ');
  const credentials = credentialsOf(p.credentials);
  const salt = random(32);
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
  const credentialIdBytes = new Uint8Array(created.rawId);
  const credentialId = base64UrlEncode(credentialIdBytes);
  const prf = prfFirst(created) ?? await evaluatePrf(credentials, credentialIdBytes, salt, p.rpId);
  const iv = random(12);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource, additionalData: aad(credentialId) as BufferSource },
    await aesKey(prf), utf8ToBytes(phrase) as BufferSource));
  return { version: 1, credentialId, prfSalt: base64UrlEncode(salt), iv: base64UrlEncode(iv), ciphertext: base64UrlEncode(ciphertext) };
}

/** Unlock a remembered phrase with its passkey. Throws if the passkey or data don't match. */
export async function unlockPhraseWithPasskey(
  stored: RememberedPhrase,
  opts: { rpId?: string; credentials?: Credentials } = {},
): Promise<string> {
  if (stored.version !== 1) throw new Error('UnsupportedRememberedPhrase');
  const prf = await evaluatePrf(credentialsOf(opts.credentials), base64UrlDecode(stored.credentialId), base64UrlDecode(stored.prfSalt), opts.rpId);
  let plain: ArrayBuffer;
  try {
    plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: base64UrlDecode(stored.iv) as BufferSource, additionalData: aad(stored.credentialId) as BufferSource },
      await aesKey(prf), base64UrlDecode(stored.ciphertext) as BufferSource);
  } catch {
    throw new Error('UnlockFailed');
  }
  return new TextDecoder().decode(plain);
}
