/**
 * E2E (#382, ADR-004): `self` accounts leave a PDS that is gone and finish
 * moving into another OpenFederation PDS with the phrase alone.
 *
 * PDS B (a second process) hosts the accounts. The person downloads a backup
 * while it still answers; then B is stopped, so every call to it fails.
 * PDS A (the in-process test server) is the new home.
 */
import type { AddressInfo } from 'node:net';
import { isPLCAvailable, uniqueHandle, testServer } from './helpers.js';
import { startSecondPds, type SecondPds } from './second-pds.js';
import { config } from '../../src/config.js';
import { runtimeSettings } from '../../src/settings/runtime-settings.js';
import {
  generateCustodyPhrase, deriveCustodyKeys, buildCustodyGenesisOp, signPlcOperation, didForGenesisOp, submitPlcOperation,
  downloadBackup, reserveSigningKeyAt, leavePds, moveIn, type RepoBackup, type MoveInStep,
} from '../../packages/openfederation-sdk/src/custody/index.js';

const PASSWORD = 'Self-move-in-pw-1!';
const PLC = config.plc.directoryUrl;
let plc = false;
let pdsA: string;
let pdsB: SecondPds | null = null;
const savedAccounts = runtimeSettings().migration.accounts;

interface Hosted { did: string; phrase: string; label: string; avatarCid: string; avatarBytes: Uint8Array; backup: RepoBackup }
const hosted: Hosted[] = [];

async function call(base: string, nsid: string, o: { jwt?: string; body?: unknown; raw?: Uint8Array; type?: string } = {}) {
  const res = await fetch(`${base}/xrpc/${nsid}`, {
    method: o.body !== undefined || o.raw ? 'POST' : 'GET',
    headers: {
      ...(o.jwt ? { Authorization: `Bearer ${o.jwt}` } : {}),
      ...(o.raw ? { 'Content-Type': o.type ?? 'application/octet-stream' } : o.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: o.raw ?? (o.body !== undefined ? JSON.stringify(o.body) : undefined),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

/** A self account signed up on B, with a post and an avatar, and its backup. */
async function selfAccountOnB(): Promise<Hosted> {
  const b = pdsB!;
  const phrase = generateCustodyPhrase();
  const keys = deriveCustodyKeys(phrase);
  const label = uniqueHandle('mover');
  const { body: { signingKey } } = await call(b.url, 'com.atproto.server.reserveSigningKey', { body: {} });
  const genesis = signPlcOperation(buildCustodyGenesisOp({
    mode: 'self', userRotationDidKey: keys.rotationDidKey, atprotoDidKey: signingKey, ownerDidKey: keys.ownerDidKey,
    handle: `${label}${b.handleSuffix}`, pdsEndpoint: b.url,
  }), keys.rotationPrivateKey);
  const did = didForGenesisOp(genesis);
  await submitPlcOperation(PLC, did, genesis);
  const registered = await call(b.url, 'net.openfederation.account.registerSelfCustody', {
    body: { did, mode: 'self', handle: label, email: `${label}@pds-b.test`, password: PASSWORD },
  });
  expect(registered.status).toBe(201);
  const session = await call(b.url, 'com.atproto.server.createSession', { body: { identifier: `${label}@pds-b.test`, password: PASSWORD } });
  expect(session.status).toBe(200);
  const jwt = session.body.accessJwt;

  const avatarBytes = new TextEncoder().encode(`avatar of ${did}`);
  const up = await call(b.url, 'com.atproto.repo.uploadBlob', { jwt, raw: avatarBytes, type: 'image/png' });
  expect(up.status).toBe(200);
  expect((await call(b.url, 'com.atproto.repo.putRecord', { jwt, body: {
    repo: did, collection: 'app.bsky.actor.profile', rkey: 'self',
    record: { $type: 'app.bsky.actor.profile', displayName: 'Mover', avatar: up.body.blob },
  } })).status).toBe(200);
  expect((await call(b.url, 'com.atproto.repo.createRecord', { jwt, body: {
    repo: did, collection: 'app.bsky.feed.post', record: { $type: 'app.bsky.feed.post', text: 'written on B', createdAt: new Date().toISOString() },
  } })).status).toBe(200);

  // The guide: download a backup before leaving, while the PDS still answers.
  const backup = await downloadBackup({ pdsUrl: b.url, did });
  expect(backup.blobs.map((x) => x.cid)).toEqual([up.body.blob.ref.$link]);
  return { did, phrase, label, avatarCid: up.body.blob.ref.$link, avatarBytes, backup };
}

beforeAll(async () => {
  plc = await isPLCAvailable();
  pdsA = `http://127.0.0.1:${(testServer.address() as AddressInfo).port}`;
  if (!plc) return;
  pdsB = await startSecondPds({ env: { ACCOUNT_APPROVAL: 'automatic', INVITE_REQUIRED: 'false' } });
  hosted.push(await selfAccountOnB(), await selfAccountOnB());
  // B is gone: from here on every call to it fails.
  await pdsB.stop();
}, 180_000);

afterAll(async () => {
  runtimeSettings().migration.accounts = savedAccounts;
  await pdsB?.stop();
});

async function expectAtHome(h: Hosted, accessJwt: string) {
  const status = await call(pdsA, 'com.atproto.server.checkAccountStatus', { jwt: accessJwt });
  expect(status.body).toMatchObject({ activated: true, validDid: true, expectedBlobs: 1, importedBlobs: 1, repoCommit: expect.any(String) });
  const data = await (await fetch(`${PLC}/${h.did}/data`)).json();
  expect(data.services.atproto_pds.endpoint).toBe(config.pds.serviceUrl);
  expect(data.rotationKeys).toEqual([deriveCustodyKeys(h.phrase).rotationDidKey]);
  expect(data.verificationMethods.openfederation_owner).toBe(deriveCustodyKeys(h.phrase).ownerDidKey);

  const posts = await (await fetch(`${pdsA}/xrpc/com.atproto.repo.listRecords?repo=${h.did}&collection=app.bsky.feed.post`)).json();
  expect(posts.records.map((r: { value: { text: string } }) => r.value.text)).toContain('written on B');
  const blob = await fetch(`${pdsA}/xrpc/com.atproto.sync.getBlob?did=${h.did}&cid=${h.avatarCid}`);
  expect(blob.status).toBe(200);
  expect(new Uint8Array(await blob.arrayBuffer())).toEqual(h.avatarBytes);

  const security = await call(pdsA, 'net.openfederation.account.getSecurityLevel', { jwt: accessJwt });
  expect(security.body.custodyMode).toBe('self');
  const written = await call(pdsA, 'com.atproto.repo.createRecord', { jwt: accessJwt, body: {
    repo: h.did, collection: 'app.bsky.feed.post', record: { $type: 'app.bsky.feed.post', text: 'written on A', createdAt: new Date().toISOString() },
  } });
  expect(written.status).toBe(200);
}

describe('self-custody move-in with the old PDS gone', () => {
  it('the old PDS answers nothing', async (ctx) => {
    if (!plc || !pdsB) ctx.skip('PLC directory not available');
    await expect(fetch(`${pdsB!.url}/health`, { signal: AbortSignal.timeout(2000) })).rejects.toThrow();
  });

  it('leavePds first, then moveIn: account created, repository and blobs imported, account active', async (ctx) => {
    if (!plc || !pdsB) ctx.skip('PLC directory not available');
    runtimeSettings().migration.accounts = 'open';
    const h = hosted[0];
    const keys = deriveCustodyKeys(h.phrase);
    const handle = `${h.label}${config.handleSuffix}`;

    // Emergency: cut the old operator off at once.
    const atprotoDidKey = await reserveSigningKeyAt({ pdsUrl: pdsA, did: h.did });
    await leavePds({ plcUrl: PLC, did: h.did, rotationPrivateKey: keys.rotationPrivateKey, pdsEndpoint: config.pds.serviceUrl, atprotoDidKey, handle });

    const steps: MoveInStep[] = [];
    const moved = await moveIn({
      plcUrl: PLC, newPdsUrl: pdsA, newServiceDid: config.pds.serviceDid, pdsEndpoint: config.pds.serviceUrl,
      did: h.did, rotationPrivateKey: keys.rotationPrivateKey, handle, email: `${h.label}@test.local`, password: PASSWORD,
      backup: h.backup, onStep: (s) => { steps.push(s); },
    });
    expect(steps).toEqual(['open', 'import', 'check', 'point', 'activate']);
    expect(moved).toMatchObject({ did: h.did, pointed: false, missingBlobs: [] });
    await expectAtHome(h, moved.accessJwt);
  });

  it('moveIn alone: opens and imports first, then points the DID with leavePds and activates', async (ctx) => {
    if (!plc || !pdsB) ctx.skip('PLC directory not available');
    runtimeSettings().migration.accounts = 'open';
    const h = hosted[1];
    const keys = deriveCustodyKeys(h.phrase);
    const moved = await moveIn({
      plcUrl: PLC, newPdsUrl: pdsA, newServiceDid: config.pds.serviceDid, pdsEndpoint: config.pds.serviceUrl,
      did: h.did, rotationPrivateKey: keys.rotationPrivateKey, handle: `${h.label}${config.handleSuffix}`,
      email: `${h.label}@test.local`, password: PASSWORD, backup: h.backup,
    });
    expect(moved).toMatchObject({ did: h.did, pointed: true });
    await expectAtHome(h, moved.accessJwt);
    const data = await (await fetch(`${PLC}/${h.did}/data`)).json();
    expect(data.alsoKnownAs).toEqual([`at://${h.label}${config.handleSuffix}`]);
  });
});
