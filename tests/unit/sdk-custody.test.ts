/**
 * @open-federation/sdk/custody (ADR-003, step 2): phrase keys, PLC operations
 * the directory accepts, owner signatures in both formats checked by the
 * server's independent verifier, and passkey unlock interoperable with
 * @open-federation/pseudonym's blobs.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { p256 } from '@noble/curves/p256';
import { secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha2';
import { hmac } from '@noble/hashes/hmac';
import { hkdf } from '@noble/hashes/hkdf';
import { utf8ToBytes } from '@noble/hashes/utils';
import {
  generateCustodyPhrase, deriveCustodyKeys, buildCustodyGenesisOp, buildCustodyChangeOp, signPlcOperation,
  didForGenesisOp, cidForPlcOp, submitPlcOperation, signOwnerRaw, verifyOwnerSignature as sdkVerify, plcOperationSigner,
  ownerChallenge, didKeyFor, rememberPhraseWithPasskey, unlockPhraseWithPasskey, rotationKeysFor,
  type OwnerSignature,
} from '../../packages/openfederation-sdk/src/custody/index.js';
import { unlockPhraseWithPasskey as pseudonymUnlock } from '../../packages/openfederation-pseudonym/src/device-unlock.js';
import { verifyOwnerSignature as serverVerify } from '../../src/identity/owner-signature.js';

const PLC = process.env.PLC_DIRECTORY_URL || 'http://localhost:2582';
const FIXED = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const b64u = (b: Uint8Array) => Buffer.from(b).toString('base64url');

async function plcUp(): Promise<boolean> {
  try { return (await fetch(`${PLC}/_health`)).ok; } catch { return false; }
}

describe('custody keys', () => {
  it('derive deterministically: two different keys from one phrase', () => {
    const a = deriveCustodyKeys(FIXED);
    const b = deriveCustodyKeys(`  ${FIXED.toUpperCase()}  `);
    expect(a.rotationDidKey).toBe(b.rotationDidKey);
    expect(a.ownerDidKey).toBe(b.ownerDidKey);
    expect(a.rotationDidKey).not.toBe(a.ownerDidKey);
    expect(a.rotationDidKey).toMatch(/^did:key:zQ3s/);
  });

  it('refuse a phrase that is not 12 valid words', () => {
    expect(() => deriveCustodyKeys('one two three')).toThrow('InvalidPhrase');
    expect(() => deriveCustodyKeys(FIXED.replace('about', 'abandon'))).toThrow('InvalidPhrase');
  });

  it('generate fresh 12-word phrases', () => {
    const p = generateCustodyPhrase();
    expect(p.split(' ')).toHaveLength(12);
    expect(deriveCustodyKeys(p).rotationDidKey).not.toBe(deriveCustodyKeys(FIXED).rotationDidKey);
  });
});

describe('PLC operations', () => {
  let plc = false;
  beforeAll(async () => { plc = await plcUp(); });
  const pdsKey = () => didKeyFor('secp256k1', secp256k1.getPublicKey(secp256k1.utils.randomPrivateKey(), true));

  it('rotation keys by mode: the user first, the PDS second in assisted', () => {
    expect(rotationKeysFor('self', { userRotationDidKey: 'u' })).toEqual(['u']);
    expect(rotationKeysFor('assisted', { userRotationDidKey: 'u', pdsRotationDidKey: 'p' })).toEqual(['u', 'p']);
    expect(rotationKeysFor('custodial', { pdsRotationDidKey: 'p' })).toEqual(['p']);
    expect(() => rotationKeysFor('assisted', { userRotationDidKey: 'u' })).toThrow(/pdsRotationDidKey/);
  });

  it('a self genesis is accepted by PLC, with the owner key published', async () => {
    if (!plc) return;
    const keys = deriveCustodyKeys(generateCustodyPhrase());
    const signed = signPlcOperation(buildCustodyGenesisOp({
      mode: 'self', userRotationDidKey: keys.rotationDidKey, atprotoDidKey: pdsKey(), ownerDidKey: keys.ownerDidKey,
      handle: 'self-test.example.test', pdsEndpoint: 'https://pds.example.test',
    }), keys.rotationPrivateKey);
    const did = didForGenesisOp(signed);
    await submitPlcOperation(PLC, did, signed);
    const data = await (await fetch(`${PLC}/${did}/data`)).json();
    expect(data.rotationKeys).toEqual([keys.rotationDidKey]);
    expect(data.verificationMethods.openfederation_owner).toBe(keys.ownerDidKey);
  });

  it('the user signs a change to assisted, then back to self; PLC accepts both', async () => {
    if (!plc) return;
    const keys = deriveCustodyKeys(generateCustodyPhrase());
    const genesis = signPlcOperation(buildCustodyGenesisOp({
      mode: 'self', userRotationDidKey: keys.rotationDidKey, atprotoDidKey: pdsKey(), ownerDidKey: keys.ownerDidKey,
      handle: 'change-test.example.test', pdsEndpoint: 'https://pds.example.test',
    }), keys.rotationPrivateKey);
    const did = didForGenesisOp(genesis);
    await submitPlcOperation(PLC, did, genesis);

    const pds = pdsKey();
    const toAssisted = buildCustodyChangeOp({ previous: genesis, rotationKeys: [keys.rotationDidKey, pds], ownerDidKey: keys.ownerDidKey });
    expect(toAssisted.prev).toBe(cidForPlcOp(genesis));
    const signedAssisted = signPlcOperation(toAssisted, keys.rotationPrivateKey);
    await submitPlcOperation(PLC, did, signedAssisted);
    expect((await (await fetch(`${PLC}/${did}/data`)).json()).rotationKeys).toEqual([keys.rotationDidKey, pds]);

    const backToSelf = signPlcOperation(buildCustodyChangeOp({ previous: signedAssisted, rotationKeys: [keys.rotationDidKey], ownerDidKey: keys.ownerDidKey }), keys.rotationPrivateKey);
    await submitPlcOperation(PLC, did, backToSelf);
    expect((await (await fetch(`${PLC}/${did}/data`)).json()).rotationKeys).toEqual([keys.rotationDidKey]);
  });

  it('PLC refuses a change signed by a key that is not a rotation key', async () => {
    if (!plc) return;
    const keys = deriveCustodyKeys(generateCustodyPhrase());
    const genesis = signPlcOperation(buildCustodyGenesisOp({
      mode: 'self', userRotationDidKey: keys.rotationDidKey, atprotoDidKey: pdsKey(), ownerDidKey: keys.ownerDidKey,
      handle: 'refuse-test.example.test', pdsEndpoint: 'https://pds.example.test',
    }), keys.rotationPrivateKey);
    const did = didForGenesisOp(genesis);
    await submitPlcOperation(PLC, did, genesis);
    const byOwnerKey = signPlcOperation(buildCustodyChangeOp({ previous: genesis, rotationKeys: [pdsKey()], ownerDidKey: null }), keys.ownerPrivateKey);
    await expect(submitPlcOperation(PLC, did, byOwnerKey)).rejects.toThrow(/PLC refused/);
  });
});

describe('plcOperationSigner', () => {
  it('names the rotation key that signed, or null', () => {
    const user = deriveCustodyKeys(generateCustodyPhrase());
    const pds = deriveCustodyKeys(generateCustodyPhrase());
    const op = buildCustodyGenesisOp({ mode: 'assisted', userRotationDidKey: user.rotationDidKey, pdsRotationDidKey: pds.rotationDidKey,
      atprotoDidKey: pds.ownerDidKey, ownerDidKey: user.ownerDidKey, handle: 'signer.example.test', pdsEndpoint: 'https://pds.example.test' });
    const keys = [user.rotationDidKey, pds.rotationDidKey];
    expect(plcOperationSigner(signPlcOperation(op, user.rotationPrivateKey), keys)).toBe(user.rotationDidKey);
    expect(plcOperationSigner(signPlcOperation(op, pds.rotationPrivateKey), keys)).toBe(pds.rotationDidKey);
    expect(plcOperationSigner(signPlcOperation(op, user.ownerPrivateKey), keys)).toBeNull();
  });
});

describe('owner signatures, signed by the SDK and checked by the server', () => {
  const text = 'OpenFederation Owner Record v1\ndid: did:plc:example\ncollection: app.example.post\ncid: bafyexample';

  it('raw secp256k1: verifies; a changed text or another key does not', () => {
    const keys = deriveCustodyKeys(FIXED);
    const sig = signOwnerRaw(keys.ownerPrivateKey, text);
    for (const verify of [serverVerify, sdkVerify]) {
      expect(verify(text, sig, keys.ownerDidKey)).toEqual({ ok: true, format: 'raw' });
      expect(verify(`${text}x`, sig, keys.ownerDidKey).ok).toBe(false);
      expect(verify(text, sig, keys.rotationDidKey).ok).toBe(false);
    }
  });

  it('raw P-256 verifies too', () => {
    const priv = p256.utils.randomPrivateKey();
    const didKey = didKeyFor('p256', p256.getPublicKey(priv, true));
    const sig: OwnerSignature = { format: 'raw', sig: b64u(p256.sign(sha256(new TextEncoder().encode(text)), priv, { lowS: true }).toCompactRawBytes()) };
    expect(serverVerify(text, sig, didKey)).toEqual({ ok: true, format: 'raw' });
    expect(sdkVerify(text, sig, didKey)).toEqual({ ok: true, format: 'raw' });
  });

  describe('webauthn (a passkey assertion, built as an authenticator would)', () => {
    const priv = p256.utils.randomPrivateKey();
    const didKey = didKeyFor('p256', p256.getPublicKey(priv, true));
    const rpIdHash = sha256(new TextEncoder().encode('app.example.test'));
    function assertion(o: { challenge?: string; type?: string; flags?: number } = {}): OwnerSignature {
      const authData = new Uint8Array(37);
      authData.set(rpIdHash); authData[32] = o.flags ?? 0x05; // UP + UV
      const clientData = new TextEncoder().encode(JSON.stringify({
        type: o.type ?? 'webauthn.get', challenge: o.challenge ?? ownerChallenge(text), origin: 'https://app.example.test',
      }));
      const signed = new Uint8Array([...authData, ...sha256(clientData)]);
      const der = p256.sign(sha256(signed), priv).toDERRawBytes();
      return { format: 'webauthn', authenticatorData: b64u(authData), clientDataJSON: b64u(clientData), signature: b64u(der) };
    }

    it('verifies, reporting origin and rpId hash', () => {
      for (const verify of [serverVerify, sdkVerify]) {
        expect(verify(text, assertion(), didKey)).toEqual({ ok: true, format: 'webauthn', origin: 'https://app.example.test', rpIdHash: b64u(rpIdHash) });
      }
    });

    it('refuses another text, a create ceremony, no user presence, or a secp256k1 key', () => {
      for (const verify of [serverVerify, sdkVerify]) {
        expect(verify(text, assertion({ challenge: ownerChallenge('other') }), didKey)).toMatchObject({ ok: false, reason: /challenge/ });
        expect(verify(text, assertion({ type: 'webauthn.create' }), didKey)).toMatchObject({ ok: false, reason: /webauthn.get/ });
        expect(verify(text, assertion({ flags: 0x04 }), didKey)).toMatchObject({ ok: false, reason: /user-present/ });
        expect(verify(text, assertion(), deriveCustodyKeys(FIXED).ownerDidKey)).toMatchObject({ ok: false, reason: /P-256/ });
      }
    });
  });
});

describe('passkey unlock (decision 12)', () => {
  /** `otherSecretAtCreate`: answers PRF at creation from another secret than sign-ins use (#251). */
  function fakeAuthenticator(otherSecretAtCreate = false, prfAsArray = false) {
    const secrets = new Map<string, Uint8Array>();
    const asBytes = (b: BufferSource) => (b instanceof ArrayBuffer ? new Uint8Array(b) : new Uint8Array(b.buffer, b.byteOffset, b.byteLength));
    const cred = (id: Uint8Array, prf: unknown) => ({ rawId: id.buffer.slice(id.byteOffset, id.byteOffset + id.byteLength), getClientExtensionResults: () => prf });
    return {
      async create(o: CredentialCreationOptions) {
        const id = crypto.getRandomValues(new Uint8Array(16));
        secrets.set(Buffer.from(id).toString('hex'), crypto.getRandomValues(new Uint8Array(32)));
        if (!otherSecretAtCreate) return cred(id, { prf: { enabled: true } });
        const salt = (o.publicKey!.extensions as { prf: { eval: { first: BufferSource } } }).prf.eval.first;
        return cred(id, { prf: { enabled: true, results: { first: hmac(sha256, crypto.getRandomValues(new Uint8Array(32)), asBytes(salt)) } } });
      },
      async get(o: CredentialRequestOptions) {
        const id = asBytes(o.publicKey!.allowCredentials![0].id);
        const secret = secrets.get(Buffer.from(id).toString('hex'));
        if (!secret) throw new Error('NotAllowedError');
        const salt = (o.publicKey!.extensions as { prf: { eval: { first: BufferSource } } }).prf.eval.first;
        const out = hmac(sha256, secret, asBytes(salt));
        return cred(id, { prf: { results: { first: prfAsArray ? Array.from(out) : out } } });
      },
    } as unknown as Pick<CredentialsContainer, 'create' | 'get'>;
  }

  it('round-trips, and the blob is the same format the pseudonym package reads', async () => {
    const credentials = fakeAuthenticator();
    const stored = await rememberPhraseWithPasskey({ phrase: FIXED, rpName: 'Test', userName: 'me', credentials });
    expect(await unlockPhraseWithPasskey(stored, { credentials })).toBe(FIXED);
    expect(await pseudonymUnlock(stored, { credentials })).toBe(FIXED);
  });

  it('uses PRF output given as a plain array (1Password), and the pseudonym package reads it too', async () => {
    const credentials = fakeAuthenticator(false, true);
    const stored = await rememberPhraseWithPasskey({ phrase: FIXED, rpName: 'Test', userName: 'me', credentials });
    expect(await unlockPhraseWithPasskey(stored, { credentials })).toBe(FIXED);
    expect(await pseudonymUnlock(stored, { credentials })).toBe(FIXED);
    // Sealed under the authenticator's secret: the key from zero PRF bytes must not open it.
    const raw = hkdf(sha256, new Uint8Array(0), utf8ToBytes('openfederation-remembered-phrase'), utf8ToBytes('aes-256-gcm-v1'), 32);
    const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
    await expect(crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: Buffer.from(stored.iv, 'base64url'), additionalData: utf8ToBytes(`openfederation-remembered-phrase-v1\n${stored.credentialId}`) },
      key, Buffer.from(stored.ciphertext, 'base64url'))).rejects.toThrow();
  });

  it('unlocks when the PRF answer at creation differs from the one at sign-in', async () => {
    const credentials = fakeAuthenticator(true);
    const stored = await rememberPhraseWithPasskey({ phrase: FIXED, rpName: 'Test', userName: 'me', credentials });
    expect(await unlockPhraseWithPasskey(stored, { credentials })).toBe(FIXED);
  });
});
