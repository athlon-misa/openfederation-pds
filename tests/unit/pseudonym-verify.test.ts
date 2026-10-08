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

describe('verifyPresence', () => {
  it('accepts the pseudonym key over the exact challenge only', async () => {
    const { bundle, pseudo } = makeBundle();
    const challenge = 'ef'.repeat(32);
    const signature = signText(pseudo.ownerPrivateKey, buildPresenceMessage({ pseudonymDid: bundle.pseudonym.did, challenge }));
    const base = { pseudonymDid: bundle.pseudonym.did, ownerKey: pseudo.ownerDidKey, challenge, signature };
    expect(await verifyPresence(base)).toBe(true);
    expect(await verifyPresence({ ...base, challenge: '01'.repeat(32) })).toBe(false);
  });
});
