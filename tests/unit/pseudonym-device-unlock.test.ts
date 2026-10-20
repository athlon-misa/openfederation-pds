import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha2';
import { generatePseudonymPhrase } from '../../packages/openfederation-pseudonym/src/keys.js';
import {
  rememberPhraseWithPasskey, unlockPhraseWithPasskey,
} from '../../packages/openfederation-pseudonym/src/device-unlock.js';

/** A fake authenticator: PRF is HMAC(credential secret, salt), like hmac-secret. */
function fakeAuthenticator(opts: { prfAtCreate?: boolean; prf?: boolean } = {}) {
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
      return credential(id, opts.prfAtCreate ? { prf: { enabled: true, results: { first: hmac(sha256, secret, asBytes(salt)) } } } : { prf: { enabled: true } });
    },
    async get(o: CredentialRequestOptions) {
      const id = asBytes(o.publicKey!.allowCredentials![0].id);
      const secret = secrets.get(key(id));
      if (!secret) throw new Error('NotAllowedError');
      const salt = (o.publicKey!.extensions as { prf: { eval: { first: BufferSource } } }).prf.eval.first;
      return credential(id, { prf: { results: { first: hmac(sha256, secret, asBytes(salt)) } } });
    },
  } as unknown as Pick<CredentialsContainer, 'create' | 'get'> & { secrets: Map<string, Uint8Array> };
}

describe('remembered phrase (passkey unlock)', () => {
  const phrase = generatePseudonymPhrase();

  it('round-trips when the authenticator answers PRF at creation', async () => {
    const credentials = fakeAuthenticator({ prfAtCreate: true });
    const stored = await rememberPhraseWithPasskey({ phrase, rpName: 'Test', userName: 'pseudonym', credentials });
    expect(JSON.stringify(stored)).not.toContain(phrase.split(' ')[0] + ' ');
    expect(await unlockPhraseWithPasskey(stored, { credentials })).toBe(phrase);
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
