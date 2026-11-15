/**
 * The device repo key kept on the device under a passkey (#240, phase 4):
 * same PRF sealing as the remembered phrase, its own labels, the did:key
 * bound in. The dashboard keeps its own copy of the format until it moves to
 * the SDK release that has it; both must read each other's blobs.
 */
import { describe, it, expect } from 'vitest';
import { sha256 } from '@noble/hashes/sha2';
import { hmac } from '@noble/hashes/hmac';
import {
  generateDeviceRepoKey, rememberDeviceKeyWithPasskey, unlockDeviceKeyWithPasskey,
  rememberPhraseWithPasskey, unlockPhraseWithPasskey,
  type RememberedDeviceKey, type RememberedPhrase,
} from '../../packages/openfederation-sdk/src/custody/index.js';
import * as dashboard from '../../web-interface/src/lib/custody/device-key-store.js';

const FIXED = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

/** A WebAuthn authenticator with PRF, as in sdk-custody.test.ts. */
function fakeAuthenticator(prfAsArray = false) {
  const secrets = new Map<string, Uint8Array>();
  let prompts = 0;
  const asBytes = (b: BufferSource) => (b instanceof ArrayBuffer ? new Uint8Array(b) : new Uint8Array(b.buffer, b.byteOffset, b.byteLength));
  const cred = (id: Uint8Array, prf: unknown) => ({ rawId: id.buffer.slice(id.byteOffset, id.byteOffset + id.byteLength), getClientExtensionResults: () => prf });
  const credentials = {
    async create() {
      prompts++;
      const id = crypto.getRandomValues(new Uint8Array(16));
      secrets.set(Buffer.from(id).toString('hex'), crypto.getRandomValues(new Uint8Array(32)));
      return cred(id, { prf: { enabled: true } });
    },
    async get(o: CredentialRequestOptions) {
      prompts++;
      const id = asBytes(o.publicKey!.allowCredentials![0].id);
      const secret = secrets.get(Buffer.from(id).toString('hex'));
      if (!secret) throw new Error('NotAllowedError');
      const salt = (o.publicKey!.extensions as { prf: { eval: { first: BufferSource } } }).prf.eval.first;
      const out = hmac(sha256, secret, asBytes(salt));
      return cred(id, { prf: { results: { first: prfAsArray ? Array.from(out) : out } } });
    },
  } as unknown as Pick<CredentialsContainer, 'create' | 'get'>;
  return { credentials, prompts: () => prompts };
}

describe('device key under a passkey (#240)', () => {
  it('round-trips and names the key in the clear', async () => {
    const { credentials } = fakeAuthenticator();
    const device = generateDeviceRepoKey();
    const stored = await rememberDeviceKeyWithPasskey({ privateKey: device.privateKey, rpName: 'Test', userName: 'me', credentials });
    expect(stored).toMatchObject({ version: 1, kind: 'device-repo-key', didKey: device.didKey });
    expect(JSON.stringify(stored)).not.toContain(Buffer.from(device.privateKey).toString('base64url'));
    const opened = await unlockDeviceKeyWithPasskey(stored, { credentials });
    expect(Buffer.from(opened.privateKey)).toEqual(Buffer.from(device.privateKey));
    expect(opened.didKey).toBe(device.didKey);
  });

  it('works with PRF output as a plain array (1Password)', async () => {
    const { credentials } = fakeAuthenticator(true);
    const device = generateDeviceRepoKey();
    const stored = await rememberDeviceKeyWithPasskey({ privateKey: device.privateKey, rpName: 'Test', userName: 'me', credentials });
    expect((await unlockDeviceKeyWithPasskey(stored, { credentials })).didKey).toBe(device.didKey);
  });

  it('reuses the passkey that unlocks the phrase: one prompt, and the two blobs never open as each other', async () => {
    const auth = fakeAuthenticator();
    const phrase: RememberedPhrase = await rememberPhraseWithPasskey({ phrase: FIXED, rpName: 'Test', userName: 'me', credentials: auth.credentials });
    const before = auth.prompts();
    const device = generateDeviceRepoKey();
    const stored = await rememberDeviceKeyWithPasskey({ privateKey: device.privateKey, rpName: 'Test', userName: 'me', credentials: auth.credentials, credentialId: phrase.credentialId });
    expect(auth.prompts() - before).toBe(1);
    expect(stored.credentialId).toBe(phrase.credentialId);
    expect(await unlockPhraseWithPasskey(phrase, { credentials: auth.credentials })).toBe(FIXED);
    expect((await unlockDeviceKeyWithPasskey(stored, { credentials: auth.credentials })).didKey).toBe(device.didKey);
    // A device-key blob presented as a phrase (or the other way round) does not open.
    await expect(unlockPhraseWithPasskey({ ...stored, version: 1 } as unknown as RememberedPhrase, { credentials: auth.credentials })).rejects.toThrow('UnlockFailed');
    await expect(unlockDeviceKeyWithPasskey({ ...phrase, kind: 'device-repo-key', didKey: device.didKey } as RememberedDeviceKey, { credentials: auth.credentials })).rejects.toThrow('UnlockFailed');
  });

  it('refuses a blob whose did:key was changed, and an invalid key', async () => {
    const { credentials } = fakeAuthenticator();
    const device = generateDeviceRepoKey();
    const stored = await rememberDeviceKeyWithPasskey({ privateKey: device.privateKey, rpName: 'Test', userName: 'me', credentials });
    await expect(unlockDeviceKeyWithPasskey({ ...stored, didKey: generateDeviceRepoKey().didKey }, { credentials })).rejects.toThrow('UnlockFailed');
    await expect(rememberDeviceKeyWithPasskey({ privateKey: new Uint8Array(32), rpName: 'Test', userName: 'me', credentials })).rejects.toThrow('InvalidDeviceKey');
  });

  it('the dashboard\'s copy of the format reads SDK blobs and the other way round', async () => {
    const { credentials } = fakeAuthenticator();
    const a = generateDeviceRepoKey();
    const fromSdk = await rememberDeviceKeyWithPasskey({ privateKey: a.privateKey, rpName: 'Test', userName: 'me', credentials });
    expect((await dashboard.unlockDeviceKeyWithPasskey(fromSdk, { credentials })).didKey).toBe(a.didKey);
    const b = generateDeviceRepoKey();
    const fromDashboard = await dashboard.rememberDeviceKeyWithPasskey({ privateKey: b.privateKey, rpName: 'Test', userName: 'me', credentials });
    expect(fromDashboard.didKey).toBe(b.didKey);
    expect(Buffer.from((await unlockDeviceKeyWithPasskey(fromDashboard, { credentials })).privateKey)).toEqual(Buffer.from(b.privateKey));
  });
});
