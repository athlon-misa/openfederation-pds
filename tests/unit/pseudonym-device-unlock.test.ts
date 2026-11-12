import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha2';
import { hkdf } from '@noble/hashes/hkdf';
import { utf8ToBytes } from '@noble/hashes/utils';
import { generatePseudonymPhrase } from '../../packages/openfederation-pseudonym/src/keys.js';
import {
  rememberPhraseWithPasskey, unlockPhraseWithPasskey,
} from '../../packages/openfederation-pseudonym/src/device-unlock.js';

/** A fake authenticator: PRF is HMAC(credential secret, salt), like hmac-secret. */
/**
 * `prfAtCreate: 'other-secret'` answers PRF at creation from a different secret
 * than sign-ins use, as an hmac-secret authenticator does when it evaluates the
 * creation-time PRF without user verification (CTAP keeps two CredRandoms).
 */
/**
 * `prfAs: 'array'` hands PRF output back as a plain number array, as the
 * 1Password extension does; `'empty'` hands back nothing usable.
 */
function fakeAuthenticator(opts: { prfAtCreate?: boolean | 'other-secret'; prf?: boolean; prfAs?: 'array' | 'empty' } = {}) {
  const secrets = new Map<string, Uint8Array>();
  const key = (id: Uint8Array) => Buffer.from(id).toString('hex');
  const asBytes = (b: BufferSource) => (b instanceof ArrayBuffer ? new Uint8Array(b) : new Uint8Array(b.buffer, b.byteOffset, b.byteLength));
  const credential = (id: Uint8Array, prf: unknown) => ({
    rawId: id.buffer.slice(id.byteOffset, id.byteOffset + id.byteLength),
    getClientExtensionResults: () => prf,
  });
  return {
    secrets,
    async create(o: CredentialCreationOptions) {
      const id = crypto.getRandomValues(new Uint8Array(16));
      const secret = crypto.getRandomValues(new Uint8Array(32));
      secrets.set(key(id), secret);
      if (opts.prf === false) return credential(id, { prf: { enabled: false } });
      const salt = (o.publicKey!.extensions as { prf: { eval: { first: BufferSource } } }).prf.eval.first;
      if (!opts.prfAtCreate) return credential(id, { prf: { enabled: true } });
      const createSecret = opts.prfAtCreate === 'other-secret' ? crypto.getRandomValues(new Uint8Array(32)) : secret;
      return credential(id, { prf: { enabled: true, results: { first: hmac(sha256, createSecret, asBytes(salt)) } } });
    },
    async get(o: CredentialRequestOptions) {
      const id = asBytes(o.publicKey!.allowCredentials![0].id);
      const secret = secrets.get(key(id));
      if (!secret) throw new Error('NotAllowedError');
      const salt = (o.publicKey!.extensions as { prf: { eval: { first: BufferSource } } }).prf.eval.first;
      const out = hmac(sha256, secret, asBytes(salt));
      const first = opts.prfAs === 'array' ? Array.from(out) : opts.prfAs === 'empty' ? [] : out;
      return credential(id, { prf: { results: { first } } });
    },
  } as unknown as Pick<CredentialsContainer, 'create' | 'get'> & { secrets: Map<string, Uint8Array> };
}

/** Whether the blob opens with the key derived from zero PRF bytes (the 1Password bug). */
async function openWithEmptyKey(stored: { credentialId: string; iv: string; ciphertext: string }): Promise<boolean> {
  const dec = (v: string) => Buffer.from(v, 'base64url');
  const raw = hkdf(sha256, new Uint8Array(0), utf8ToBytes('openfederation-remembered-phrase'), utf8ToBytes('aes-256-gcm-v1'), 32);
  const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
  try {
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv: dec(stored.iv), additionalData: utf8ToBytes(`openfederation-remembered-phrase-v1\n${stored.credentialId}`) }, key, dec(stored.ciphertext));
    return true;
  } catch { return false; }
}

describe('remembered phrase (passkey unlock)', () => {
  const phrase = generatePseudonymPhrase();

  it('round-trips when the authenticator answers PRF at creation', async () => {
    const credentials = fakeAuthenticator({ prfAtCreate: true });
    const stored = await rememberPhraseWithPasskey({ phrase, rpName: 'Test', userName: 'pseudonym', credentials });
    expect(JSON.stringify(stored)).not.toContain(phrase.split(' ')[0] + ' ');
    expect(await unlockPhraseWithPasskey(stored, { credentials })).toBe(phrase);
  });

  it('unlocks when the PRF answer at creation differs from the one at sign-in', async () => {
    // Seen on a real authenticator (#251): the phrase was saved, then no unlock opened it.
    const credentials = fakeAuthenticator({ prfAtCreate: 'other-secret' });
    const stored = await rememberPhraseWithPasskey({ phrase, rpName: 'Test', userName: 'p', credentials });
    expect(await unlockPhraseWithPasskey(stored, { credentials })).toBe(phrase);
  });

  it('uses PRF output given as a plain array, not an empty key (1Password)', async () => {
    const credentials = fakeAuthenticator({ prfAs: 'array' });
    const stored = await rememberPhraseWithPasskey({ phrase, rpName: 'Test', userName: 'p', credentials });
    expect(await unlockPhraseWithPasskey(stored, { credentials })).toBe(phrase);
    // Sealed under the authenticator's secret: a key from no PRF bytes must not open it.
    expect(await openWithEmptyKey(stored)).toBe(false);
  });

  it('refuses PRF output too short to be a key', async () => {
    const credentials = fakeAuthenticator({ prfAs: 'empty' });
    await expect(rememberPhraseWithPasskey({ phrase, rpName: 'Test', userName: 'p', credentials })).rejects.toThrow('PasskeyPrfUnsupported');
  });

  it('falls back to a sign-in when PRF only works on get', async () => {
    const credentials = fakeAuthenticator({ prfAtCreate: false });
    const stored = await rememberPhraseWithPasskey({ phrase: `  ${phrase.toUpperCase()} `, rpName: 'Test', userName: 'p', credentials });
    expect(await unlockPhraseWithPasskey(stored, { credentials })).toBe(phrase);
  });

  it('refuses when the authenticator has no PRF', async () => {
    const credentials = fakeAuthenticator({ prf: false });
    await expect(rememberPhraseWithPasskey({ phrase, rpName: 'Test', userName: 'p', credentials })).rejects.toThrow('PasskeyPrfUnsupported');
  });

  it('refuses an invalid phrase before creating a passkey', async () => {
    const credentials = fakeAuthenticator();
    await expect(rememberPhraseWithPasskey({ phrase: 'not a real phrase', rpName: 'Test', userName: 'p', credentials })).rejects.toThrow('InvalidPhrase');
    expect(credentials.secrets.size).toBe(0);
  });

  it('fails with a different passkey secret or tampered data', async () => {
    const credentials = fakeAuthenticator();
    const stored = await rememberPhraseWithPasskey({ phrase, rpName: 'Test', userName: 'p', credentials });
    const [id] = [...credentials.secrets.keys()];
    credentials.secrets.set(id, crypto.getRandomValues(new Uint8Array(32)));
    await expect(unlockPhraseWithPasskey(stored, { credentials })).rejects.toThrow('UnlockFailed');

    const other = fakeAuthenticator();
    const good = await rememberPhraseWithPasskey({ phrase, rpName: 'Test', userName: 'p', credentials: other });
    const flipped = good.ciphertext.slice(0, -2) + (good.ciphertext.endsWith('AA') ? 'BA' : 'AA');
    await expect(unlockPhraseWithPasskey({ ...good, ciphertext: flipped }, { credentials: other })).rejects.toThrow('UnlockFailed');
  });
});
