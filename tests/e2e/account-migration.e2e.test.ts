/**
 * E2E: moving a pseudonym between two PDSes sharing one PLC directory.
 * PDS A is the in-process test server; PDS B is a second process
 * (second-pds.ts). Later migration slices extend this file.
 */
import type { AddressInfo } from 'node:net';
import { isPLCAvailable, createTestUser, uniqueHandle, testServer, xrpcGet } from './helpers.js';
import { startSecondPds, type SecondPds } from './second-pds.js';
import { config } from '../../src/config.js';
import {
  fetchTokenKeys, collectTokens, createPseudonym, loginWithPhrase, openAccountForMove, moveAccount, type MoveStep,
} from '../../packages/openfederation-pseudonym/src/index.js';

let plc = false;
let pdsA: string;
let pdsB: SecondPds | null = null;

beforeAll(async () => {
  plc = await isPLCAvailable();
  pdsA = `http://127.0.0.1:${(testServer.address() as AddressInfo).port}`;
  if (plc) pdsB = await startSecondPds();
}, 150_000);

afterAll(async () => {
  await pdsB?.stop();
});

async function get(base: string, nsid: string, jwt: string) {
  const res = await fetch(`${base}/xrpc/${nsid}`, { headers: { Authorization: `Bearer ${jwt}` } });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

function post(base: string, jwt: string, did: string, url: string) {
  return fetch(`${base}/xrpc/com.atproto.repo.createRecord`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
    body: JSON.stringify({
      repo: did, collection: 'net.openfederation.authorship.claim',
      record: { $type: 'net.openfederation.authorship.claim', contentHash: 'ab'.repeat(32), url, createdAt: new Date().toISOString() },
    }),
  });
}

describe('account migration', () => {
  it('opens a deactivated account for a pseudonym on the new PDS; the old home keeps working', async (ctx) => {
    if (!plc || !pdsB) ctx.skip('PLC directory not available');
    const owner = await createTestUser(uniqueHandle('mig-owner'));
    const keys = await fetchTokenKeys(pdsA);
    const [token] = await collectTokens({ pdsUrl: pdsA, accessJwt: owner.accessJwt, keys, count: config.pseudonym.tokensPerEpoch });
    const pseudonym = await createPseudonym({
      pdsUrl: pdsA, plcUrl: config.plc.directoryUrl, pdsServiceUrl: config.pds.serviceUrl,
      handle: `${uniqueHandle('mover')}${config.handleSuffix}`, ownerDid: owner.did, token,
    });

    const label = pseudonym.handle.slice(0, -config.handleSuffix.length);
    const opened = await openAccountForMove({
      newPdsUrl: pdsB!.url, newServiceDid: pdsB!.serviceDid, phrase: pseudonym.phrase,
      did: pseudonym.did, handle: `${label}${pdsB!.handleSuffix}`,
    });
    expect(opened.did).toBe(pseudonym.did);

    // B: deactivated, empty repo, and the DID does not point at B yet.
    const status = await get(pdsB!.url, 'com.atproto.server.checkAccountStatus', opened.accessJwt);
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({ activated: false, validDid: false, indexedRecords: 0 });

    // Opening it twice is refused.
    await expect(openAccountForMove({
      newPdsUrl: pdsB!.url, newServiceDid: pdsB!.serviceDid, phrase: pseudonym.phrase,
      did: pseudonym.did, handle: `${label}-2${pdsB!.handleSuffix}`,
    })).rejects.toThrow(/AlreadyExists/);

    // A: nothing changed for readers or for the owner.
    const described = await xrpcGet('com.atproto.repo.describeRepo', { repo: pseudonym.did });
    expect(described.status).toBe(200);
    const session = await loginWithPhrase({ pdsUrl: pdsA, phrase: pseudonym.phrase, expectedServiceDid: config.pds.serviceDid });
    expect(session.did).toBe(pseudonym.did);

    // #262: export from A, import into B. A's key still signs the DID, so B verifies it.
    const posted = await fetch(`${pdsA}/xrpc/com.atproto.repo.createRecord`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.accessJwt}` },
      body: JSON.stringify({
        repo: pseudonym.did, collection: 'net.openfederation.authorship.claim',
        record: { $type: 'net.openfederation.authorship.claim', contentHash: 'cd'.repeat(32), url: 'https://news.example/moving', createdAt: new Date().toISOString() },
      }),
    });
    expect(posted.status).toBe(200);
    const car = new Uint8Array(await (await fetch(`${pdsA}/xrpc/com.atproto.sync.getRepo?did=${pseudonym.did}`)).arrayBuffer());
    const imported = await fetch(`${pdsB!.url}/xrpc/com.atproto.repo.importRepo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/vnd.ipld.car', Authorization: `Bearer ${opened.accessJwt}` },
      body: car,
    });
    expect(imported.status).toBe(200);

    const after = await get(pdsB!.url, 'com.atproto.server.checkAccountStatus', opened.accessJwt);
    expect(after.body).toMatchObject({ activated: false, validDid: false });
    expect(after.body.indexedRecords).toBeGreaterThanOrEqual(2); // profile + claim
    const onB = await fetch(`${pdsB!.url}/xrpc/com.atproto.repo.listRecords?repo=${pseudonym.did}&collection=net.openfederation.authorship.claim`);
    expect((await onB.json()).records.map((r: { value: { url: string } }) => r.value.url)).toContain('https://news.example/moving');
  });

  it('moves a pseudonym end to end: it logs in and publishes at the new home, the old home is retired', async (ctx) => {
    if (!plc || !pdsB) ctx.skip('PLC directory not available');
    const owner = await createTestUser(uniqueHandle('mv-owner'));
    const keys = await fetchTokenKeys(pdsA);
    const [token] = await collectTokens({ pdsUrl: pdsA, accessJwt: owner.accessJwt, keys, count: config.pseudonym.tokensPerEpoch });
    const nd = await createPseudonym({
      pdsUrl: pdsA, plcUrl: config.plc.directoryUrl, pdsServiceUrl: config.pds.serviceUrl,
      handle: `${uniqueHandle('nightdesk')}${config.handleSuffix}`, ownerDid: owner.did, token,
    });
    const atA = await loginWithPhrase({ pdsUrl: pdsA, phrase: nd.phrase, expectedServiceDid: config.pds.serviceDid });
    const story = await post(pdsA, atA.accessJwt, nd.did, 'https://news.example/before-the-move');
    expect(story.status).toBe(200);

    // #264: an avatar the profile references must come along.
    const avatarBytes = new TextEncoder().encode(`night desk avatar ${nd.did}`);
    const uploaded = await fetch(`${pdsA}/xrpc/com.atproto.repo.uploadBlob`, {
      method: 'POST', headers: { 'Content-Type': 'image/png', Authorization: `Bearer ${atA.accessJwt}` }, body: avatarBytes,
    });
    expect(uploaded.status).toBe(200);
    const { blob: avatar } = await uploaded.json();
    const profile = await fetch(`${pdsA}/xrpc/com.atproto.repo.putRecord`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${atA.accessJwt}` },
      body: JSON.stringify({ repo: nd.did, collection: 'app.bsky.actor.profile', rkey: 'self',
        record: { $type: 'app.bsky.actor.profile', displayName: 'Night Desk', avatar } }),
    });
    expect(profile.status).toBe(200);

    const steps: MoveStep[] = [];
    const label = nd.handle.slice(0, -config.handleSuffix.length);
    const newHandle = `${label}${pdsB!.handleSuffix}`;
    const session = await moveAccount({
      oldPdsUrl: pdsA, oldServiceDid: config.pds.serviceDid,
      newPdsUrl: pdsB!.url, newServiceDid: pdsB!.serviceDid,
      plcUrl: config.plc.directoryUrl, phrase: nd.phrase, did: nd.did, newHandle,
      onStep: (s) => steps.push(s),
    });
    expect(steps).toEqual(['open', 'export', 'import', 'blobs', 'check', 'point', 'activate', 'retire']);
    expect(session.did).toBe(nd.did);

    // The DID now names B, with the new handle and the commitment kept.
    const doc = await (await fetch(`${config.plc.directoryUrl}/${nd.did}`)).json();
    expect(doc.service[0].serviceEndpoint).toBe(pdsB!.url);
    expect(doc.alsoKnownAs[0]).toBe(`at://${newHandle}`);
    expect(doc.alsoKnownAs.some((a: string) => a.startsWith('urn:openfederation:pseudonym-commitment:'))).toBe(true);

    // B: activated, the old story arrived, and a new one can be published.
    const status = await get(pdsB!.url, 'com.atproto.server.checkAccountStatus', session.accessJwt);
    expect(status.body).toMatchObject({ activated: true, validDid: true });
    expect((await fetch(`${pdsB!.url}/xrpc/com.atproto.repo.describeRepo?repo=${nd.did}`)).status).toBe(200);
    expect((await post(pdsB!.url, session.accessJwt, nd.did, 'https://news.example/after-the-move')).status).toBe(200);
    const urls = (await (await fetch(`${pdsB!.url}/xrpc/com.atproto.repo.listRecords?repo=${nd.did}&collection=net.openfederation.authorship.claim`)).json())
      .records.map((r: { value: { url: string } }) => r.value.url);
    expect(urls).toEqual(expect.arrayContaining(['https://news.example/before-the-move', 'https://news.example/after-the-move']));
    expect(status.body).toMatchObject({ expectedBlobs: 1, importedBlobs: 1 });
    const served = await fetch(`${pdsB!.url}/xrpc/com.atproto.sync.getBlob?did=${nd.did}&cid=${avatar.ref.$link}`);
    expect(served.status).toBe(200);
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(avatarBytes);

    // A: deactivated, so the old session and the phrase no longer work there.
    expect((await post(pdsA, atA.accessJwt, nd.did, 'https://news.example/stale')).status).toBe(401);
    await expect(loginWithPhrase({ pdsUrl: pdsA, phrase: nd.phrase, expectedServiceDid: config.pds.serviceDid }))
      .rejects.toThrow(/AccountNotActive/);
  });
});
