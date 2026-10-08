import { describe, it, expect } from 'vitest';
import { derivePseudonymKeys, generatePseudonymPhrase, signText } from '../../packages/openfederation-pseudonym/src/keys.js';
import { buildPseudonymGenesisOp, signGenesisOp, didForSignedOp } from '../../packages/openfederation-pseudonym/src/plc.js';
import { buildLinkStatement, buildPresenceMessage } from '../../packages/openfederation-pseudonym/src/formats.js';
import { verifyRevealBundle, verifyPresence } from '../../src/identity/pseudonym/verify.js';

function makeBundle() {
  const pseudo = derivePseudonymKeys(generatePseudonymPhrase());
  const root = derivePseudonymKeys(generatePseudonymPhrase()); // stands in for Ana's root signing key
  const ownerDid = 'did:plc:anaanaanaanaanaanaanaana';
  const genesisOp = signGenesisOp(buildPseudonymGenesisOp({
    ownerDidKey: pseudo.ownerDidKey, signingDidKey: pseudo.ownerDidKey, handle: 'nightdesk.pds.test',
    pdsEndpoint: 'https://pds.test', ownerDid, commitmentSaltHex: pseudo.commitmentSaltHex,
  }), pseudo.ownerPrivateKey);
  const pseudonymDid = didForSignedOp(genesisOp);
  const statement = buildLinkStatement({ pseudonymDid, ownerDid, issuedAt: '2026-10-08T10:00:00.000Z' });
  return {
    pseudo, root,
    bundle: {
      version: 1 as const, statement, commitmentSalt: pseudo.commitmentSaltHex,
      pseudonym: { did: pseudonymDid, sig: signText(pseudo.ownerPrivateKey, statement), genesisOp: genesisOp as any },
      owner: { did: ownerDid, sig: signText(root.ownerPrivateKey, statement), signingKey: root.ownerDidKey },
    },
  };
}

const failed = (r: { checks: { name: string; ok: boolean }[] }) => r.checks.filter((c) => !c.ok).map((c) => c.name);

describe('verifyRevealBundle (offline)', () => {
  it('accepts a genuine bundle', async () => {
    const r = await verifyRevealBundle(makeBundle().bundle);
    expect(r.valid).toBe(true);
    expect(r.checks.map((c) => c.name)).toEqual(['statement', 'genesisHash', 'genesisSignature', 'pseudonymSignature', 'commitment', 'ownerSignature']);
  });

  it('a thief with the pseudonym key cannot claim it for another owner', async () => {
    const { bundle, pseudo, root } = makeBundle();
    const mallory = 'did:plc:mallorymallorymallorymal';
    const statement = buildLinkStatement({ pseudonymDid: bundle.pseudonym.did, ownerDid: mallory, issuedAt: '2026-10-09T10:00:00.000Z' });
    const stolen = { ...bundle, statement,
      pseudonym: { ...bundle.pseudonym, sig: signText(pseudo.ownerPrivateKey, statement) },
      owner: { did: mallory, sig: signText(root.ownerPrivateKey, statement), signingKey: root.ownerDidKey } };
    expect(failed(await verifyRevealBundle(stolen))).toEqual(['commitment']);
  });

  it('pins each tampering to its check', async () => {
    const { bundle } = makeBundle();
    expect(failed(await verifyRevealBundle({ ...bundle, commitmentSalt: 'cd'.repeat(32) }))).toEqual(['commitment']);
    expect(failed(await verifyRevealBundle({ ...bundle, pseudonym: { ...bundle.pseudonym, genesisOp: makeBundle().bundle.pseudonym.genesisOp } }))).toContain('genesisHash');
    expect(failed(await verifyRevealBundle({ ...bundle, owner: { ...bundle.owner, sig: bundle.pseudonym.sig } }))).toEqual(['ownerSignature']);
    expect(failed(await verifyRevealBundle({ ...bundle, statement: bundle.statement + ' ' }))).toContain('statement');
    expect((await verifyRevealBundle({ nonsense: true })).valid).toBe(false);
  });
});

describe('hostile input never throws', () => {
  it('Infinity or undefined in genesisOp fails a check', async () => {
    const { bundle } = makeBundle();
    for (const bad of [Infinity, undefined]) {
      const op = { ...bundle.pseudonym.genesisOp, services: { x: { n: bad } } };
      const r = await verifyRevealBundle({ ...bundle, pseudonym: { ...bundle.pseudonym, genesisOp: op } });
      expect(r.valid).toBe(false);
    }
    const nested = { ...bundle.pseudonym.genesisOp, rotationKeys: [1e400 as any] };
    expect((await verifyRevealBundle({ ...bundle, pseudonym: { ...bundle.pseudonym, genesisOp: nested } })).valid).toBe(false);
  });
});

describe('owner key binding', () => {
  it('framing bundle passes offline signatures but ownerKeyBound is unchecked; online rejects it', async () => {
    const victim = 'did:plc:victimvictimvictimvictim';
    const pseudo = derivePseudonymKeys(generatePseudonymPhrase());
    const attacker = derivePseudonymKeys(generatePseudonymPhrase());
    const genesisOp = signGenesisOp(buildPseudonymGenesisOp({
      ownerDidKey: pseudo.ownerDidKey, signingDidKey: pseudo.ownerDidKey, handle: 'frame.pds.test',
      pdsEndpoint: 'https://pds.test', ownerDid: victim, commitmentSaltHex: pseudo.commitmentSaltHex,
    }), pseudo.ownerPrivateKey);
    const pseudonymDid = didForSignedOp(genesisOp);
    const statement = buildLinkStatement({ pseudonymDid, ownerDid: victim, issuedAt: '2026-10-08T10:00:00.000Z' });
    const bundle = {
      version: 1 as const, statement, commitmentSalt: pseudo.commitmentSaltHex,
      pseudonym: { did: pseudonymDid, sig: signText(pseudo.ownerPrivateKey, statement), genesisOp: genesisOp as any },
      owner: { did: victim, sig: signText(attacker.ownerPrivateKey, statement), signingKey: attacker.ownerDidKey },
    };
    const off = await verifyRevealBundle(bundle);
    expect(off.valid).toBe(true);
    expect(off.ownerKeyBound).toBe('unchecked');
    const victimKey = derivePseudonymKeys(generatePseudonymPhrase()).ownerDidKey;
    const docFor = (k: string) => async () => ({ verificationMethod: [{ id: 'x#atproto', publicKeyMultibase: k.replace('did:key:', '') }] });
    const on = await verifyRevealBundle(bundle, { online: true, resolveDoc: docFor(victimKey) });
    expect(on.valid).toBe(false);
    expect(on.ownerKeyBound).toBe('failed');
  });

  it('online confirms when the DID document key matches', async () => {
    const { bundle } = makeBundle();
    const doc = async () => ({ verificationMethod: [{ id: 'did:plc:x#atproto', publicKeyMultibase: bundle.owner.signingKey.replace('did:key:', '') }] });
    const r = await verifyRevealBundle(bundle, { online: true, resolveDoc: doc });
    expect(r.valid).toBe(true);
    expect(r.ownerKeyBound).toBe('confirmed');
    const down = await verifyRevealBundle(bundle, { online: true, resolveDoc: async () => { throw new Error('down'); } });
    expect(down.ownerKeyBound).toBe('failed');
  });
});

describe('verifyPresence', () => {
  it('binds the signature to the pseudonym genesis key', async () => {
    const { bundle, pseudo } = makeBundle();
    const challenge = 'ef'.repeat(32);
    const genesisOp = bundle.pseudonym.genesisOp;
    const mk = (key: typeof pseudo) => signText(key.ownerPrivateKey, buildPresenceMessage({ pseudonymDid: bundle.pseudonym.did, challenge }));
    const base = { pseudonymDid: bundle.pseudonym.did, genesisOp, challenge, signature: mk(pseudo) };
    expect(await verifyPresence(base)).toBe(true);
    expect(await verifyPresence({ ...base, challenge: '01'.repeat(32) })).toBe(false);
    // a fresh key signing the right message is not the genesis key
    expect(await verifyPresence({ ...base, signature: mk(derivePseudonymKeys(generatePseudonymPhrase())) })).toBe(false);
    // genesis op belonging to a different DID
    expect(await verifyPresence({ ...base, genesisOp: makeBundle().bundle.pseudonym.genesisOp })).toBe(false);
    expect(await verifyPresence({ ...base, genesisOp: null as any })).toBe(false);
  });
});

describe('genesis shape matches the server rules (genesis.ts)', () => {
  // Build a correctly hashed and signed bundle from a mutated genesis op.
  function variant(mutate: (op: any, extra: ReturnType<typeof derivePseudonymKeys>) => void) {
    const pseudo = derivePseudonymKeys(generatePseudonymPhrase());
    const root = derivePseudonymKeys(generatePseudonymPhrase());
    const extra = derivePseudonymKeys(generatePseudonymPhrase());
    const ownerDid = 'did:plc:anaanaanaanaanaanaanaana';
    const op: any = buildPseudonymGenesisOp({
      ownerDidKey: pseudo.ownerDidKey, signingDidKey: pseudo.ownerDidKey, handle: 'nightdesk.pds.test',
      pdsEndpoint: 'https://pds.test', ownerDid, commitmentSaltHex: pseudo.commitmentSaltHex,
    });
    mutate(op, extra);
    const genesisOp = signGenesisOp(op, pseudo.ownerPrivateKey);
    const pseudonymDid = didForSignedOp(genesisOp);
    const statement = buildLinkStatement({ pseudonymDid, ownerDid, issuedAt: '2026-10-08T10:00:00.000Z' });
    const challenge = 'ef'.repeat(32);
    return {
      bundle: {
        version: 1 as const, statement, commitmentSalt: pseudo.commitmentSaltHex,
        pseudonym: { did: pseudonymDid, sig: signText(pseudo.ownerPrivateKey, statement), genesisOp: genesisOp as any },
        owner: { did: ownerDid, sig: signText(root.ownerPrivateKey, statement), signingKey: root.ownerDidKey },
      },
      presence: {
        pseudonymDid, genesisOp: genesisOp as any, challenge,
        signature: signText(pseudo.ownerPrivateKey, buildPresenceMessage({ pseudonymDid, challenge })),
      },
    };
  }

  it('an unmodified variant passes (control)', async () => {
    const v = variant(() => {});
    expect((await verifyRevealBundle(v.bundle)).valid).toBe(true);
    expect(await verifyPresence(v.presence)).toBe(true);
  });

  it('two commitment URNs fail the commitment check, even when one is correct', async () => {
    const v = variant((op) => { op.alsoKnownAs.push(`urn:openfederation:pseudonym-commitment:v1:${'ab'.repeat(32)}`); });
    expect(failed(await verifyRevealBundle(v.bundle))).toEqual(['commitment']);
    expect(await verifyPresence(v.presence)).toBe(false);
  });

  it('a malformed extra commitment URN also fails', async () => {
    const v = variant((op) => { op.alsoKnownAs.push('urn:openfederation:pseudonym-commitment:v1:not-hex'); });
    expect(failed(await verifyRevealBundle(v.bundle))).toEqual(['commitment']);
    expect(await verifyPresence(v.presence)).toBe(false);
  });

  it('two rotation keys fail the genesis check', async () => {
    const v = variant((op, extra) => { op.rotationKeys.push(extra.ownerDidKey); });
    expect(failed(await verifyRevealBundle(v.bundle))).toContain('genesisSignature');
    expect(await verifyPresence(v.presence)).toBe(false);
  });
});
