/**
 * Daily unlock for a phrase-controlled identity: type the twelve words once on
 * a device, then unlock them with a passkey (Face ID, Touch ID, Windows Hello,
 * a security key). Issue #251, ADR-003 decision 12. Same format as
 * @open-federation/pseudonym's helpers, so a stored blob works with either.
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
import { utf8ToBytes } from '@noble/hashes/utils';
import { normalizePhrase } from './keys.js';
import { openWithPasskey, sealWithPasskey, type Credentials, type SealLabels } from './passkey-seal.js';

/** The encrypted phrase. Safe to keep in local storage: useless without the passkey. */
export interface RememberedPhrase {
  version: 1;
  credentialId: string;
  prfSalt: string;
  iv: string;
  ciphertext: string;
}

const PHRASE_LABELS: SealLabels = {
  salt: 'openfederation-remembered-phrase',
  aad: (credentialId) => `openfederation-remembered-phrase-v1\n${credentialId}`,
};

/**
 * Create a passkey on this device and encrypt the phrase with it. Asks for
 * Touch ID (or similar) twice: once to create the passkey, once to sign in
 * with it, which gives the key that seals the phrase.
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
  const phrase = normalizePhrase(p.phrase); // refuse to store a phrase that isn't valid
  const sealed = await sealWithPasskey({
    plaintext: utf8ToBytes(phrase), labels: PHRASE_LABELS,
    rpName: p.rpName, userName: p.userName, rpId: p.rpId, credentials: p.credentials,
  });
  return { version: 1, ...sealed };
}

/** Unlock a remembered phrase with its passkey. Throws if the passkey or data don't match. */
export async function unlockPhraseWithPasskey(
  stored: RememberedPhrase,
  opts: { rpId?: string; credentials?: Credentials } = {},
): Promise<string> {
  if (stored.version !== 1) throw new Error('UnsupportedRememberedPhrase');
  return new TextDecoder().decode(await openWithPasskey(stored, PHRASE_LABELS, opts));
}
