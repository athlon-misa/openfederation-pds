/**
 * E2E: full pseudonym lifecycle against the real local PLC directory.
 * Also confirms that PLC accepts the commitment URN in alsoKnownAs.
 */
import type { AddressInfo } from 'node:net';
import { vi } from 'vitest';
import { isPLCAvailable, createTestUser, uniqueHandle, xrpcAuthPost, testServer } from './helpers.js';
import { config } from '../../src/config.js';
import {
  fetchTokenKeys, collectTokens, createPseudonym, loginWithPhrase, createRevealBundle, publishReveal, signPresence,
} from '../../packages/openfederation-pseudonym/src/index.js';
import { verifyRevealBundle, verifyPresence } from '../../src/identity/pseudonym/verify.js';

let plc = false;
let pdsUrl: string;
beforeAll(async () => {
  plc = await isPLCAvailable();
  pdsUrl = `http://127.0.0.1:${(testServer.address() as AddressInfo).port}`;
});

describe('pseudonym lifecycle', () => {
  it('collect tokens → create → phrase login → claim → reveal → verify → presence', async (ctx) => {
    if (!plc) ctx.skip('PLC directory not available');
    const ana = await createTestUser(uniqueHandle('ana'));
    const keys = await fetchTokenKeys(pdsUrl);
    const tokens = await collectTokens({ pdsUrl, accessJwt: ana.accessJwt, keys, count: config.pseudonym.tokensPerEpoch });
    expect(tokens).toHaveLength(config.pseudonym.tokensPerEpoch);

    const created = await createPseudonym({
      pdsUrl, plcUrl: config.plc.directoryUrl, pdsServiceUrl: config.pds.serviceUrl,
      handle: `${uniqueHandle('nightdesk')}${config.handleSuffix}`, ownerDid: ana.did, token: tokens[0],
    });
    expect(created.phrase.split(' ')).toHaveLength(12);

    // A challenge naming any other service is refused before anything is signed.
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      await expect(loginWithPhrase({ pdsUrl, phrase: created.phrase, expectedServiceDid: 'did:web:other-pds.example' }))
        .rejects.toThrow(/refusing to sign/);
      const urls = fetchSpy.mock.calls.map(([u]) => String(u));
      expect(urls.some((u) => u.includes('pseudonym.getLoginChallenge'))).toBe(true);
      expect(urls.some((u) => u.includes('pseudonym.createSession'))).toBe(false);
    } finally {
      fetchSpy.mockRestore();
    }

    const session = await loginWithPhrase({ pdsUrl, phrase: created.phrase, expectedServiceDid: config.pds.serviceDid });
    expect(session.did).toBe(created.did);

    const claim = await xrpcAuthPost('com.atproto.repo.createRecord', session.accessJwt, {
      repo: created.did, collection: 'net.openfederation.authorship.claim',
      record: { $type: 'net.openfederation.authorship.claim', contentHash: 'ab'.repeat(32), url: 'https://news.example/port-leak', createdAt: new Date().toISOString() },
    });
    expect(claim.status).toBe(200);

    const bundle = await createRevealBundle({
      pdsUrl, plcUrl: config.plc.directoryUrl, phrase: created.phrase, pseudonymDid: created.did, ownerDid: ana.did, ownerAccessJwt: ana.accessJwt,
    });
    const offline = await verifyRevealBundle(bundle);
    expect(offline.valid).toBe(true);
    expect(offline.ownerKeyBound).toBe('unchecked');
    const online = await verifyRevealBundle(bundle, { online: true, plcUrl: config.plc.directoryUrl });
    expect(online.checks.filter((c) => !c.ok)).toEqual([]);
    expect(online.valid).toBe(true);
    expect(online.ownerKeyBound).toBe('confirmed');

    await publishReveal({ pdsUrl, bundle, pseudonymAccessJwt: session.accessJwt, ownerAccessJwt: ana.accessJwt });

    const challenge = 'ab'.repeat(32);
    const proof = signPresence({ phrase: created.phrase, pseudonymDid: created.did, challenge });
    expect(await verifyPresence({ pseudonymDid: created.did, genesisOp: bundle.pseudonym.genesisOp, challenge, signature: proof.signature })).toBe(true);
  });
});
