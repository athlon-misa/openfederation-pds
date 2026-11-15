/**
 * Keeping the device repo key (#240) on the device, encrypted with a passkey:
 * the same WebAuthn PRF sealing as the remembered phrase (decision 12), with
 * its own labels, so a phrase blob never opens as a key and the other way
 * round. The blob names the key's did:key in the clear (so an app can tell
 * whether this device holds the key the DID names without unlocking it) and
 * binds it into the encryption, so a blob whose did:key was edited does not
 * open.
 *
 *   const device = generateDeviceRepoKey();
 *   const stored = await rememberDeviceKeyWithPasskey({ privateKey: device.privateKey, rpName: 'My app', userName: handle });
 *   localStorage.setItem('device-key', JSON.stringify(stored));   // useless without the passkey
 *   …
 *   const { privateKey } = await unlockDeviceKeyWithPasskey(stored);
 *
 * Pass `credentialId` (for example the passkey that already unlocks the
 * phrase, `RememberedPhrase.credentialId`) to reuse a passkey: one prompt
 * instead of two. Without PRF support these throw `PasskeyPrfUnsupported`;
 * keep the key some other way the application trusts, never under a weaker
 * secret.
 *
 * Losing the device (or clearing the browser) loses the key, not the
 * account: the phrase or a recovery key points the DID at a new device key
 * (`setDeviceRepoKey`, `rotateDeviceRepoKey`).
 */
import { secp256k1 } from '@noble/curves/secp256k1';
import { didKeyFor } from './encoding.js';
import { openWithPasskey, sealWithPasskey, type Credentials, type SealLabels } from './passkey-seal.js';

/** The encrypted device key. Safe to keep in local storage: useless without the passkey. */
export interface RememberedDeviceKey {
  version: 1;
  kind: 'device-repo-key';
  /** did:key of the sealed key (secp256k1), in the clear. */
  didKey: string;
  credentialId: string;
  prfSalt: string;
  iv: string;
  ciphertext: string;
}

function labelsFor(didKey: string): SealLabels {
  return {
    salt: 'openfederation-device-repo-key',
    aad: (credentialId) => `openfederation-device-repo-key-v1\n${credentialId}\n${didKey}`,
  };
}

function didKeyOf(privateKey: Uint8Array): string {
  return didKeyFor('secp256k1', secp256k1.getPublicKey(privateKey, true));
}

/** Encrypt the device repo key with a passkey (a new one, or `credentialId`). */
export async function rememberDeviceKeyWithPasskey(p: {
  privateKey: Uint8Array;
  rpName: string;
  userName: string;
  rpId?: string;
  credentials?: Credentials;
  /** Reuse this passkey (base64url credential id) instead of creating one. */
  credentialId?: string;
}): Promise<RememberedDeviceKey> {
  if (!(p.privateKey instanceof Uint8Array) || p.privateKey.length !== 32 || !secp256k1.utils.isValidPrivateKey(p.privateKey)) {
    throw new Error('InvalidDeviceKey');
  }
  const didKey = didKeyOf(p.privateKey);
  const sealed = await sealWithPasskey({
    plaintext: p.privateKey, labels: labelsFor(didKey),
    rpName: p.rpName, userName: p.userName, rpId: p.rpId, credentials: p.credentials, credentialId: p.credentialId,
  });
  return { version: 1, kind: 'device-repo-key', didKey, ...sealed };
}

/** Unlock a remembered device key with its passkey. Throws `UnlockFailed` if the passkey or data don't match. */
export async function unlockDeviceKeyWithPasskey(
  stored: RememberedDeviceKey,
  opts: { rpId?: string; credentials?: Credentials } = {},
): Promise<{ privateKey: Uint8Array; didKey: string }> {
  if (stored.version !== 1 || stored.kind !== 'device-repo-key') throw new Error('UnsupportedRememberedDeviceKey');
  const privateKey = await openWithPasskey(stored, labelsFor(stored.didKey), opts);
  if (privateKey.length !== 32 || didKeyOf(privateKey) !== stored.didKey) throw new Error('UnlockFailed');
  return { privateKey, didKey: stored.didKey };
}
