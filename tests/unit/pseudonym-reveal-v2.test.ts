/**
 * Reveal bundles v2 (ADR-003, decision 8). The owner side says which key
 * signed: `openfederation_owner` (the person's own key, raw or passkey) or
 * `atproto` (the PDS-held repo key, as in v1). Online, the key is confirmed
 * under that name in the owner's DID document, and the verdict says whether
 * the person or only their PDS-held key signed. v1 bundles keep verifying,
 * with the custodial wording.
 */
import { describe, it, expect } from 'vitest';
import { p256 } from '@noble/curves/p256';
import { sha256 } from '@noble/hashes/sha2';
import { derivePseudonymKeys, generatePseudonymPhrase, signText } from '../../packages/openfederation-pseudonym/src/keys.js';
import { buildPseudonymGenesisOp, signGenesisOp, didForSignedOp } from '../../packages/openfederation-pseudonym/src/plc.js';
import { buildLinkStatement } from '../../packages/openfederation-pseudonym/src/formats.js';
import {
  deriveCustodyKeys, generateCustodyPhrase, signOwnerRaw, ownerChallenge, didKeyFor, buildCustodyGenesisOp,
  signPlcOperation, didForGenesisOp, submitPlcOperation, type OwnerSignature,
} from '../../packages/openfederation-sdk/src/custody/index.js';
import { verifyRevealBundle } from '../../src/identity/pseudonym/verify.js';

const PLC = process.env.PLC_DIRECTORY_URL || 'http://localhost:2582';
const b64u = (b: Uint8Array) => Buffer.from(b).toString('base64url');

/** A pseudonym committed to `ownerDid`, and the link statement. */
function pseudonymFor(ownerDid: string) {
  const pseudo = derivePseudonymKeys(generatePseudonymPhrase());
  const genesisOp = signGenesisOp(buildPseudonymGenesisOp({
    ownerDidKey: pseudo.ownerDidKey, signingDidKey: pseudo.ownerDidKey, handle: 'nightdesk.pds.test',
    pdsEndpoint: 'https://pds.test', ownerDid, commitmentSaltHex: pseudo.commitmentSaltHex,
  }), pseudo.ownerPrivateKey);
  const did = didForSignedOp(genesisOp);
  const statement = buildLinkStatement({ pseudonymDid: did, ownerDid, issuedAt: '2026-11-12T10:00:00.000Z' });
  return { statement, salt: pseudo.commitmentSaltHex, pseudonym: { did, sig: signText(pseudo.ownerPrivateKey, statement), genesisOp: genesisOp as any } };
}

function v2(ownerDid: string, keyRef: 'openfederation_owner' | 'atproto', signingKey: string, sign: (text: string) => OwnerSignature) {
  const p = pseudonymFor(ownerDid);
  return {
    version: 2 as const, statement: p.statement, commitmentSalt: p.salt, pseudonym: p.pseudonym,
    owner: { did: ownerDid, keyRef, signingKey, signature: sign(p.statement) },
  };
}

/** A DID document as PLC serves it: verification methods by #fragment with Multikey publicKeyMultibase. */
function docWith(did: string, methods: Record<string, string>) {
  return {
    id: did,
    verificationMethod: Object.entries(methods).map(([name, didKey]) => ({
      id: `${did}#${name}`, type: 'Multikey', controller: did, publicKeyMultibase: didKey.slice('did:key:'.length),
    })),
  };
}

const OWNER = 'did:plc:ownerownerownerownerowne';

describe('reveal bundles v2', () => {
  it('a person-signed bundle (raw secp256k1 owner key): valid offline, "person" once the DID confirms the owner key', async () => {
    const keys = deriveCustodyKeys(generateCustodyPhrase());
    const bundle = v2(OWNER, 'openfederation_owner', keys.ownerDidKey, (t) => signOwnerRaw(keys.ownerPrivateKey, t));
    const offline = await verifyRevealBundle(bundle);
    expect(offline).toMatchObject({ valid: true, ownerKeyBound: 'unchecked', ownerKeyRef: 'openfederation_owner', ownerAttestation: 'unchecked' });

    const online = await verifyRevealBundle(bundle, { online: true, resolveDoc: async () => docWith(OWNER, { atproto: deriveCustodyKeys(generateCustodyPhrase()).rotationDidKey, openfederation_owner: keys.ownerDidKey }) });
    expect(online).toMatchObject({ valid: true, ownerKeyBound: 'confirmed', ownerAttestation: 'person' });
  });

  it('a passkey-signed bundle (P-256, webauthn format) is a person signature too', async () => {
    const priv = p256.utils.randomPrivateKey();
    const ownerKey = didKeyFor('p256', p256.getPublicKey(priv, true));
    const sign = (text: string): OwnerSignature => {
      const authData = new Uint8Array(37); authData.set(sha256(new TextEncoder().encode('app.example.test'))); authData[32] = 0x05;
      const clientData = new TextEncoder().encode(JSON.stringify({ type: 'webauthn.get', challenge: ownerChallenge(text), origin: 'https://app.example.test' }));
      const der = p256.sign(sha256(new Uint8Array([...authData, ...sha256(clientData)])), priv).toDERRawBytes();
      return { format: 'webauthn', authenticatorData: b64u(authData), clientDataJSON: b64u(clientData), signature: b64u(der) };
    };
    const bundle = v2(OWNER, 'openfederation_owner', ownerKey, sign);
    const online = await verifyRevealBundle(bundle, { online: true, resolveDoc: async () => docWith(OWNER, { openfederation_owner: ownerKey }) });
    expect(online).toMatchObject({ valid: true, ownerKeyBound: 'confirmed', ownerAttestation: 'person' });
  });

  it('an atproto-keyed v2 bundle keeps the custodial verdict', async () => {
    const pds = deriveCustodyKeys(generateCustodyPhrase());
    const bundle = v2(OWNER, 'atproto', pds.ownerDidKey, (t) => signOwnerRaw(pds.ownerPrivateKey, t));
    const online = await verifyRevealBundle(bundle, { online: true, resolveDoc: async () => docWith(OWNER, { atproto: pds.ownerDidKey }) });
    expect(online).toMatchObject({ valid: true, ownerKeyRef: 'atproto', ownerAttestation: 'pds-held-key' });
  });

  it('claiming a person key the DID lists only as #atproto fails online', async () => {
    const keys = deriveCustodyKeys(generateCustodyPhrase());
    const bundle = v2(OWNER, 'openfederation_owner', keys.ownerDidKey, (t) => signOwnerRaw(keys.ownerPrivateKey, t));
    const online = await verifyRevealBundle(bundle, { online: true, resolveDoc: async () => docWith(OWNER, { atproto: keys.ownerDidKey }) });
    expect(online.valid).toBe(false);
    expect(online.ownerKeyBound).toBe('failed');
  });

  it('a signature by another key, or over another text, fails the owner check', async () => {
    const keys = deriveCustodyKeys(generateCustodyPhrase());
    const other = deriveCustodyKeys(generateCustodyPhrase());
    const wrongKey = v2(OWNER, 'openfederation_owner', keys.ownerDidKey, (t) => signOwnerRaw(other.ownerPrivateKey, t));
    expect((await verifyRevealBundle(wrongKey)).checks.filter((c) => !c.ok).map((c) => c.name)).toEqual(['ownerSignature']);
    const wrongText = v2(OWNER, 'openfederation_owner', keys.ownerDidKey, (t) => signOwnerRaw(keys.ownerPrivateKey, `${t}x`));
    expect((await verifyRevealBundle(wrongText)).valid).toBe(false);
  });

  it('a v1 bundle still verifies, reported as the PDS-held atproto key', async () => {
    const root = derivePseudonymKeys(generatePseudonymPhrase());
    const p = pseudonymFor(OWNER);
    const v1 = { version: 1 as const, statement: p.statement, commitmentSalt: p.salt, pseudonym: p.pseudonym,
      owner: { did: OWNER, sig: signText(root.ownerPrivateKey, p.statement), signingKey: root.ownerDidKey } };
    const online = await verifyRevealBundle(v1, { online: true, resolveDoc: async () => docWith(OWNER, { atproto: root.ownerDidKey }) });
    expect(online).toMatchObject({ valid: true, ownerKeyRef: 'atproto', ownerAttestation: 'pds-held-key' });
  });

  it('against the live PLC directory: a self account\'s owner key is read from its real DID document', async () => {
    let up = false;
    try { up = (await fetch(`${PLC}/_health`)).ok; } catch { up = false; }
    if (!up) return;
    const keys = deriveCustodyKeys(generateCustodyPhrase());
    const genesis = signPlcOperation(buildCustodyGenesisOp({
      mode: 'self', userRotationDidKey: keys.rotationDidKey, atprotoDidKey: deriveCustodyKeys(generateCustodyPhrase()).rotationDidKey,
      ownerDidKey: keys.ownerDidKey, handle: 'reveal-owner.example.test', pdsEndpoint: 'https://pds.example.test',
    }), keys.rotationPrivateKey);
    const ownerDid = didForGenesisOp(genesis);
    await submitPlcOperation(PLC, ownerDid, genesis);
    const bundle = v2(ownerDid, 'openfederation_owner', keys.ownerDidKey, (t) => signOwnerRaw(keys.ownerPrivateKey, t));
    const online = await verifyRevealBundle(bundle, { online: true, plcUrl: PLC });
    expect(online).toMatchObject({ valid: true, ownerKeyBound: 'confirmed', ownerAttestation: 'person' });
  });
});
