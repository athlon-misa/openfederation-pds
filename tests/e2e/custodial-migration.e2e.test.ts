/**
 * E2E (#266): a user account whose keys PDS A holds moves to PDS B.
 */
import type { AddressInfo } from 'node:net';
import { isPLCAvailable, createTestUser, uniqueHandle, testServer } from './helpers.js';
import { startSecondPds, type SecondPds } from './second-pds.js';
import { config } from '../../src/config.js';
import { setEmailSenderForTests } from '../../src/email/email-service.js';
import { moveCustodialAccount, type CustodialMoveStep } from './custodial-move.js';

const PASSWORD = 'TestPassword123!';
let plc = false;
let pdsA: string;
let pdsB: SecondPds | null = null;
const mails: { to: string; html: string }[] = [];

beforeAll(async () => {
  plc = await isPLCAvailable();
  pdsA = `http://127.0.0.1:${(testServer.address() as AddressInfo).port}`;
  setEmailSenderForTests(async (to, _s, html) => { mails.push({ to, html }); });
  if (plc) pdsB = await startSecondPds();
}, 150_000);

afterAll(async () => {
  setEmailSenderForTests(null);
  await pdsB?.stop();
});

async function json(res: Response) { return res.json().catch(() => ({})); }

describe('custodial account migration', () => {
  it('moves a user from A to B: password login at B, posts there, blobs along, A retired', async (ctx) => {
    if (!plc || !pdsB) ctx.skip('PLC directory not available');
    const user = await createTestUser(uniqueHandle('cust'));
    const email = `${user.handle}@test.local`;
    const auth = { Authorization: `Bearer ${user.accessJwt}` };
    const avatarBytes = new TextEncoder().encode(`avatar of ${user.did}`);
    const up = await fetch(`${pdsA}/xrpc/com.atproto.repo.uploadBlob`, { method: 'POST', headers: { ...auth, 'Content-Type': 'image/png' }, body: avatarBytes });
    const { blob: avatar } = await json(up);
    const profile = await fetch(`${pdsA}/xrpc/com.atproto.repo.putRecord`, {
      method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo: user.did, collection: 'app.bsky.actor.profile', rkey: 'self', record: { $type: 'app.bsky.actor.profile', displayName: 'Mover', avatar } }),
    });
    expect(profile.status).toBe(200);
    const post = await fetch(`${pdsA}/xrpc/com.atproto.repo.createRecord`, {
      method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo: user.did, collection: 'app.bsky.feed.post', record: { $type: 'app.bsky.feed.post', text: 'before', createdAt: new Date().toISOString() } }),
    });
    expect(post.status).toBe(200);

    const steps: CustodialMoveStep[] = [];
    const newHandle = `${user.handle}${pdsB!.handleSuffix}`;
    const moved = await moveCustodialAccount({
      oldPdsUrl: pdsA, newPdsUrl: pdsB!.url, newServiceDid: pdsB!.serviceDid, plcUrl: config.plc.directoryUrl,
      did: user.did, handle: user.handle, password: PASSWORD, email, newHandle,
      readCode: async () => {
        const code = [...mails].reverse().find((m) => m.to === email && /[0-9A-F]{5}-[0-9A-F]{5}/.test(m.html))?.html.match(/[0-9A-F]{5}-[0-9A-F]{5}/)?.[0];
        if (!code) throw new Error('No code was emailed');
        return code;
      },
      onStep: (s) => steps.push(s),
    });
    expect(steps).toEqual(['open', 'export', 'import', 'blobs', 'check', 'sign', 'point', 'activate', 'retire']);
    expect(moved.rotationDeviceShare).toBeTruthy();

    // The DID names B, B's rotation key, B's signing key and the new handle.
    const data = await json(await fetch(`${config.plc.directoryUrl}/${user.did}/data`));
    expect(data.services.atproto_pds.endpoint).toBe(pdsB!.url);
    expect(data.alsoKnownAs).toEqual([`at://${newHandle}`]);
    const statusB = await json(await fetch(`${pdsB!.url}/xrpc/com.atproto.server.checkAccountStatus`, { headers: { Authorization: `Bearer ${moved.accessJwt}` } }));
    expect(statusB).toMatchObject({ activated: true, validDid: true, expectedBlobs: 1, importedBlobs: 1 });
    const credsB = await json(await fetch(`${pdsB!.url}/xrpc/com.atproto.identity.getRecommendedDidCredentials`, { headers: { Authorization: `Bearer ${moved.accessJwt}` } }));
    expect(data.rotationKeys).toEqual(credsB.rotationKeys);

    // B: the old post and avatar are there, and a new post works.
    const posts = await json(await fetch(`${pdsB!.url}/xrpc/com.atproto.repo.listRecords?repo=${user.did}&collection=app.bsky.feed.post`));
    expect(posts.records.map((r: { value: { text: string } }) => r.value.text)).toContain('before');
    expect((await fetch(`${pdsB!.url}/xrpc/com.atproto.sync.getBlob?did=${user.did}&cid=${avatar.ref.$link}`)).status).toBe(200);
    const after = await fetch(`${pdsB!.url}/xrpc/com.atproto.repo.createRecord`, {
      method: 'POST', headers: { Authorization: `Bearer ${moved.accessJwt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo: user.did, collection: 'app.bsky.feed.post', record: { $type: 'app.bsky.feed.post', text: 'after', createdAt: new Date().toISOString() } }),
    });
    expect(after.status).toBe(200);

    // A: deactivated, with a limited session only.
    const atA = await json(await fetch(`${pdsA}/xrpc/com.atproto.server.createSession`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: user.handle, password: PASSWORD }),
    }));
    expect(atA).toMatchObject({ active: false, status: 'deactivated' });
  });
});
