/**
 * The device repo key (#240), kept in this browser under a passkey.
 *
 * Same format as `rememberDeviceKeyWithPasskey` / `unlockDeviceKeyWithPasskey`
 * in @open-federation/sdk/custody (from 0.8.0), and the same WebAuthn PRF
 * sealing as the remembered 12 words (`rememberPhraseWithPasskey`, including
 * the password-manager fix of #374). The dashboard builds against the
 * published SDK, which does not have these two functions yet; once it does,
 * import them from the SDK and delete this file. tests/unit/sdk-device-key-store.test.ts
 * checks that the two read each other's blobs.
 *
 * No relative imports or `@/` paths here, so the root test suite can load it.
 */
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha2';
import { utf8ToBytes } from '@noble/hashes/utils';
import { secp256k1 } from '@noble/curves/secp256k1';
import { base64UrlDecode, base64UrlEncode, didKeyFor } from '@open-federation/sdk/custody';

type Credentials = Pick<CredentialsContainer, 'create' | 'get'>;

/** The encrypted device key. Safe to keep in local storage: useless without the passkey. */
export interface RememberedDeviceKey {
  version: 1;
  kind: 'device-repo-key';
  didKey: string;
  credentialId: string;
  prfSalt: string;
  iv: string;
  ciphertext: string;
}

const SALT = 'openfederation-device-repo-key';
const aad = (credentialId: string, didKey: string) => utf8ToBytes(`openfederation-device-repo-key-v1\n${credentialId}\n${didKey}`);

function credentialsOf(c?: Credentials): Credentials {
  const found = c ?? (globalThis.navigator?.credentials as Credentials | undefined);
  if (!found) throw new Error('PasskeyPrfUnsupported');
  return found;
}

function random(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

async function aesKey(prf: Uint8Array): Promise<CryptoKey> {
  const raw = hkdf(sha256, prf, utf8ToBytes(SALT), utf8ToBytes('aes-256-gcm-v1'), 32);
  return crypto.subtle.importKey('raw', raw as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/** PRF output as bytes (ArrayBuffer, a view, or 1Password's plain array); never fewer than 32 bytes. */
function prfFirst(cred: PublicKeyCredential): Uint8Array | null {
  const first = (cred.getClientExtensionResults() as { prf?: { results?: { first?: unknown } } }).prf?.results?.first;
  let bytes: Uint8Array | null = null;
  if (first instanceof ArrayBuffer || Object.prototype.toString.call(first) === '[object ArrayBuffer]') bytes = new Uint8Array(first as ArrayBuffer);
  else if (ArrayBuffer.isView(first)) bytes = new Uint8Array(first.buffer, first.byteOffset, first.byteLength);
  else if (Array.isArray(first) && first.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) bytes = Uint8Array.from(first as number[]);
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

const didKeyOf = (privateKey: Uint8Array) => didKeyFor('secp256k1', secp256k1.getPublicKey(privateKey, true));

/** Encrypt the device key with a passkey: a new one, or `credentialId` (the one that unlocks the 12 words). */
export async function rememberDeviceKeyWithPasskey(p: {
  privateKey: Uint8Array; rpName: string; userName: string; rpId?: string; credentials?: Credentials; credentialId?: string;
}): Promise<RememberedDeviceKey> {
  if (p.privateKey.length !== 32 || !secp256k1.utils.isValidPrivateKey(p.privateKey)) throw new Error('InvalidDeviceKey');
  const credentials = credentialsOf(p.credentials);
  const salt = random(32);
  let idBytes: Uint8Array;
  if (p.credentialId) {
    idBytes = base64UrlDecode(p.credentialId);
  } else {
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
    if ((created.getClientExtensionResults() as { prf?: { enabled?: boolean } }).prf?.enabled === false) throw new Error('PasskeyPrfUnsupported');
    idBytes = new Uint8Array(created.rawId);
  }
  const credentialId = base64UrlEncode(idBytes);
  const didKey = didKeyOf(p.privateKey);
  // The key always comes from a sign-in, as when unlocking (#251).
  const prf = await evaluatePrf(credentials, idBytes, salt, p.rpId);
  const iv = random(12);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource, additionalData: aad(credentialId, didKey) as BufferSource },
    await aesKey(prf), p.privateKey as BufferSource));
  return { version: 1, kind: 'device-repo-key', didKey, credentialId, prfSalt: base64UrlEncode(salt), iv: base64UrlEncode(iv), ciphertext: base64UrlEncode(ciphertext) };
}

/** Unlock the device key with its passkey. Throws `UnlockFailed` if the passkey or data don't match. */
export async function unlockDeviceKeyWithPasskey(stored: RememberedDeviceKey, opts: { rpId?: string; credentials?: Credentials } = {}): Promise<{ privateKey: Uint8Array; didKey: string }> {
  if (stored.version !== 1 || stored.kind !== 'device-repo-key') throw new Error('UnsupportedRememberedDeviceKey');
  const prf = await evaluatePrf(credentialsOf(opts.credentials), base64UrlDecode(stored.credentialId), base64UrlDecode(stored.prfSalt), opts.rpId);
  let privateKey: Uint8Array;
  try {
    privateKey = new Uint8Array(await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: base64UrlDecode(stored.iv) as BufferSource, additionalData: aad(stored.credentialId, stored.didKey) as BufferSource },
      await aesKey(prf), base64UrlDecode(stored.ciphertext) as BufferSource));
  } catch {
    throw new Error('UnlockFailed');
  }
  if (privateKey.length !== 32 || didKeyOf(privateKey) !== stored.didKey) throw new Error('UnlockFailed');
  return { privateKey, didKey: stored.didKey };
}
