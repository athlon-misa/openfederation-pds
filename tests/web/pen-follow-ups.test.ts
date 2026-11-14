/**
 * Dashboard pen-name follow-ups (#412), on the @open-federation/pseudonym the
 * dashboard pins (0.3.1, from web-interface/node_modules): the in-person link
 * names its context (c=) and /verify checks it in that one; the service DID
 * can be pinned; a proof publishes the package's record across servers.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  challengeForWord, signPresence, presenceLinkFragment, generatePseudonymPhrase, derivePseudonymKeys,
  buildPseudonymGenesisOp, signGenesisOp, didForSignedOp, verifyLink, type RevealBundleV2,
} from '../../web-interface/node_modules/@open-federation/pseudonym/dist/index.js';
import { revealLinkRecord } from '../../packages/openfederation-pseudonym/src/client.js';
import {
  IN_PERSON_CONTEXT, STAGE_PRESENCE_CONTEXT, presenceContextOf, withPresenceContext,
} from '../../web-interface/src/lib/verify/presence-context.js';
import { assertPinnedServiceDid, serverProblem } from '../../web-interface/src/lib/pen-names/service-pin.js';
import { IN_PERSON_CONTEXT as PACKAGE_IN_PERSON, STAGE_PRESENCE_CONTEXT as PACKAGE_STAGE } from '../../packages/openfederation-pseudonym/src/verify.js';

const PLC = 'http://plc.test';

afterEach(() => vi.restoreAllMocks());

function penName() {
  const phrase = generatePseudonymPhrase();
  const keys = derivePseudonymKeys(phrase);
  const genesisOp = signGenesisOp(buildPseudonymGenesisOp({
    ownerDidKey: keys.ownerDidKey, signingDidKey: keys.ownerDidKey, handle: 'quill.pds.test',
    pdsEndpoint: 'https://pds.test', ownerDid: 'did:plc:abcdefghijklmnopqrstuvwx', commitmentSaltHex: keys.commitmentSaltHex,
  }), keys.ownerPrivateKey);
  const did = didForSignedOp(genesisOp);
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input);
    if (url === `${PLC}/${did}/log`) return new Response(JSON.stringify([genesisOp]), { status: 200 });
    if (url === `${PLC}/${did}`) return new Response(JSON.stringify({ id: did, alsoKnownAs: ['at://quill.pds.test'] }), { status: 200 });
    return new Response('{}', { status: 404 });
  });
  return { phrase, did };
}

/** What /verify does with a fragment, with the pinned package. */
const verifyAsPage = (fragment: string) => verifyLink(fragment, { plcUrl: PLC, presenceContext: presenceContextOf(fragment) });

describe('in-person link context (dashboard)', () => {
  it('uses the same contexts as the package', () => {
    expect(IN_PERSON_CONTEXT).toBe(PACKAGE_IN_PERSON);
    expect(STAGE_PRESENCE_CONTEXT).toBe(PACKAGE_STAGE);
  });

  it('a new dashboard link carries the generic context and verifies; altered, it does not', async () => {
    const pen = penName();
    const { signature } = signPresence({ phrase: pen.phrase, pseudonymDid: pen.did, challenge: challengeForWord('lantern', IN_PERSON_CONTEXT) });
    const fragment = withPresenceContext(presenceLinkFragment({ pseudonymDid: pen.did, word: 'lantern', signature }));
    expect(new URLSearchParams(fragment).get('c')).toBe(IN_PERSON_CONTEXT);
    expect(presenceContextOf(`#${fragment}`)).toBe(IN_PERSON_CONTEXT);
    expect((await verifyAsPage(fragment)).valid).toBe(true);

    const altered = new URLSearchParams(fragment);
    altered.set('c', STAGE_PRESENCE_CONTEXT);
    expect((await verifyAsPage(altered.toString())).valid).toBe(false);
    altered.set('c', 'OpenFederation in-person proof!');
    expect((await verifyAsPage(altered.toString())).valid).toBe(false);
  });

  it('an old stage link (no c=) still verifies, in the stage context', async () => {
    const pen = penName();
    const { signature } = signPresence({ phrase: pen.phrase, pseudonymDid: pen.did, challenge: challengeForWord('lantern', STAGE_PRESENCE_CONTEXT) });
    const fragment = presenceLinkFragment({ pseudonymDid: pen.did, word: 'lantern', signature });
    expect(presenceContextOf(fragment)).toBe(STAGE_PRESENCE_CONTEXT);
    expect((await verifyAsPage(fragment)).valid).toBe(true);
  });

  it('refuses a malformed context', () => {
    expect(() => presenceContextOf('w=a&d=x&s=y&c=')).toThrow();
    expect(() => presenceContextOf(`w=a&d=x&s=y&c=${'x'.repeat(201)}`)).toThrow();
    expect(() => presenceContextOf('w=a&d=x&s=y&c=a%0Ab')).toThrow();
    expect(() => withPresenceContext('w=a', 'two\nlines')).toThrow();
  });
});

describe('pinned service DID (dashboard)', () => {
  const THIS = 'https://pds.example.com';
  it('unset: anything goes, as before', () => {
    expect(() => assertPinnedServiceDid(THIS, 'did:web:evil.example', THIS, '')).not.toThrow();
  });
  it('set: this dashboard\'s server must name the pinned DID', () => {
    expect(() => assertPinnedServiceDid(THIS, 'did:web:pds.example.com', THIS, 'did:web:pds.example.com')).not.toThrow();
    expect(() => assertPinnedServiceDid(`${THIS}/`, 'did:web:pds.example.com', THIS, 'did:web:pds.example.com')).not.toThrow();
    expect(() => assertPinnedServiceDid(THIS, 'did:web:evil.example', THIS, 'did:web:pds.example.com')).toThrow(/set up for did:web:pds\.example\.com/);
    expect(() => assertPinnedServiceDid(THIS, '', THIS, 'did:web:pds.example.com')).toThrow();
  });
  it('a mismatch is shown as it is; other failures with their context', () => {
    let err: unknown;
    try { assertPinnedServiceDid(THIS, 'did:web:evil.example', THIS, 'did:web:pds.example.com'); } catch (e) { err = e; }
    expect(serverProblem(err, 'Could not reach this server')).toMatch(/^This server says it is did:web:evil\.example/);
    expect(serverProblem(new Error('timeout'), 'Could not reach this server')).toBe('Could not reach this server: timeout');
  });
  it('set: other servers (typed by the person) are not pinned', () => {
    expect(() => assertPinnedServiceDid('https://other.example', 'did:web:other.example', THIS, 'did:web:pds.example.com')).not.toThrow();
  });
});

describe('proof record (dashboard, across servers)', () => {
  it('is the record the package publishes', async () => {
    const { proofRecord } = await import('../../web-interface/src/lib/pen-names/pen-names.js');
    const bundle = {
      version: 2, statement: 's', commitmentSalt: 'ab', pseudonym: { did: 'did:plc:pen', sig: 'ps', genesisOp: {} },
      owner: { did: 'did:plc:owner', keyRef: 'openfederation_owner', signingKey: 'did:key:z', signature: { format: 'raw', sig: 'os' } },
    } as unknown as RevealBundleV2;
    expect(proofRecord(bundle, 't')).toEqual(revealLinkRecord(bundle, 't'));
  });
});
