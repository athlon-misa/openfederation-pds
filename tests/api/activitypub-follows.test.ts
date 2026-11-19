/**
 * A community's ActivityPub actor answers follows (#464).
 *
 * A fake Mastodon server (alice's actor document and inbox) signs a Follow
 * with alice's key; the PDS checks it and sends a signed Accept to her inbox.
 * Unsigned, forged, altered and stale Follows are refused, and a key document
 * claiming to be somebody else is not believed.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import http from 'http';
import type { AddressInfo } from 'net';
import { api, createTestUser, isPLCAvailable, uniqueHandle, xrpcAuthPost } from './helpers.js';
import { config } from '../../src/config.js';
import { signedPostHeaders, parseSignatureHeader, verifySignedPost } from '../../src/activitypub/http-signature.js';
import { resolveSigner } from '../../src/activitypub/follows.js';

function rsa() {
  return crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
}

interface Received { path: string; headers: http.IncomingHttpHeaders; body: Buffer }

describe('ActivityPub follows of a community (#464)', () => {
  let plc = false;
  let communityDid: string;
  let actorId: string;
  let inboxPath: string;

  const alice = rsa();
  const mallory = rsa();
  let fake: http.Server;
  let base: string;
  const received: Received[] = [];

  const aliceId = () => `${base}/users/alice`;
  const malloryId = () => `${base}/users/mallory`;

  function actorDoc(id: string, publicKeyPem: string) {
    return {
      '@context': ['https://www.w3.org/ns/activitystreams', 'https://w3id.org/security/v1'],
      id, type: 'Person', preferredUsername: id.split('/').pop(),
      inbox: `${id}/inbox`,
      publicKey: { id: `${id}#main-key`, owner: id, publicKeyPem },
    };
  }

  beforeAll(async () => {
    fake = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const path = req.url ?? '/';
        if (req.method === 'POST') {
          received.push({ path, headers: req.headers, body: Buffer.concat(chunks) });
          res.writeHead(202); res.end(); return;
        }
        const docs: Record<string, unknown> = {
          '/users/alice': actorDoc(aliceId(), alice.publicKey),
          '/users/mallory': actorDoc(malloryId(), mallory.publicKey),
          // A key document hosted by mallory that names alice as its owner.
          '/keys/impostor': { id: `${base}/keys/impostor`, owner: aliceId(), publicKeyPem: mallory.publicKey },
          // A document at mallory's address claiming to be alice.
          '/users/fake-alice': { ...actorDoc(aliceId(), mallory.publicKey), publicKey: { id: `${base}/users/fake-alice#main-key`, owner: aliceId(), publicKeyPem: mallory.publicKey } },
        };
        const doc = docs[path.split('?')[0]];
        if (!doc) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { 'content-type': 'application/activity+json' });
        res.end(JSON.stringify(doc));
      });
    });
    await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;

    plc = await isPLCAvailable();
    if (!plc) return;
    const owner = await createTestUser(uniqueHandle('apf-owner'));
    const created = await xrpcAuthPost('net.openfederation.community.create', owner.accessJwt, {
      handle: uniqueHandle('apf-comm'), didMethod: 'plc', visibility: 'public', joinPolicy: 'open',
    });
    expect(created.status).toBe(201);
    communityDid = created.body.did;
    const linked = await xrpcAuthPost('net.openfederation.community.linkApplication', owner.accessJwt, {
      communityDid, appType: 'mastodon', instanceUrl: 'https://mastodon.example.test',
    });
    expect(linked.status).toBeLessThan(300);
    actorId = `${config.pds.serviceUrl}/ap/actor/${communityDid}`;
    inboxPath = `/ap/actor/${communityDid}/inbox`;
  });

  afterAll(async () => {
    await new Promise((r) => fake.close(r));
  });

  function follow(id: string, from = aliceId(), object = actorId) {
    return JSON.stringify({ '@context': 'https://www.w3.org/ns/activitystreams', id: `${base}/follows/${id}`, type: 'Follow', actor: from, object });
  }

  async function deliver(body: string, opts: { keyOwner?: string; key?: string; sendBody?: string; date?: Date } = {}) {
    const headers = signedPostHeaders({
      url: `${config.pds.serviceUrl}${inboxPath}`,
      body,
      keyId: `${opts.keyOwner ?? aliceId()}#main-key`,
      privateKeyPem: opts.key ?? alice.privateKey,
      date: opts.date,
    });
    let req = api.post(inboxPath);
    for (const [name, value] of Object.entries(headers)) req = req.set(name, value);
    return req.send(opts.sendBody ?? body);
  }

  async function waitForDelivery(count: number) {
    for (let i = 0; i < 50 && received.length < count; i++) await new Promise((r) => setTimeout(r, 100));
  }

  it('a signed Follow is answered with a signed Accept in the follower\'s inbox', async () => {
    if (!plc) return;
    const before = received.length;
    const body = follow('1');
    const res = await deliver(body);
    expect(res.status).toBe(202);
    await waitForDelivery(before + 1);
    expect(received.length).toBe(before + 1);

    const got = received[received.length - 1];
    expect(got.path).toBe('/users/alice/inbox');
    const accept = JSON.parse(got.body.toString('utf-8'));
    expect(accept).toMatchObject({
      type: 'Accept',
      actor: actorId,
      object: { id: `${base}/follows/1`, type: 'Follow', actor: aliceId(), object: actorId },
    });

    // Signed with the key the community's actor publishes.
    const actor = await api.get(inboxPath.replace(/\/inbox$/, '')).set('Accept', 'application/activity+json');
    const publicKeyPem = JSON.parse(actor.text).publicKey.publicKeyPem;
    const signature = parseSignatureHeader(String(got.headers.signature));
    expect(signature?.keyId).toBe(`${actorId}#main-key`);
    const headers = Object.fromEntries(Object.entries(got.headers).map(([k, v]) => [k, String(v)]));
    expect(verifySignedPost({ signature: signature!, path: got.path, headers, body: got.body, publicKeyPem })).toBeNull();
  });

  it('refuses an unsigned Follow', async () => {
    if (!plc) return;
    const res = await api.post(inboxPath).set('Content-Type', 'application/activity+json').send(follow('2'));
    expect(res.status).toBe(401);
  });

  it('refuses a Follow signed by someone other than the follower it names', async () => {
    if (!plc) return;
    const res = await deliver(follow('3', aliceId()), { keyOwner: malloryId(), key: mallory.privateKey });
    expect(res.status).toBe(401);
  });

  it('refuses a Follow whose body changed after signing, or with an old date', async () => {
    if (!plc) return;
    expect((await deliver(follow('4'), { sendBody: follow('4-altered') })).status).toBe(401);
    expect((await deliver(follow('5'), { date: new Date(Date.now() - 3 * 60 * 60 * 1000) })).status).toBe(401);
  });

  it('acknowledges anything else without answering', async () => {
    if (!plc) return;
    const before = received.length;
    const undo = JSON.stringify({ id: `${base}/undo/1`, type: 'Undo', actor: aliceId(), object: JSON.parse(follow('1')) });
    expect((await deliver(undo)).status).toBe(202);
    expect((await deliver(follow('6', aliceId(), `${config.pds.serviceUrl}/ap/actor/did:plc:someoneelse`))).status).toBe(202);
    await new Promise((r) => setTimeout(r, 500));
    expect(received.length).toBe(before);
  });

  it('a key is believed only when its owner\'s own document lists it', async () => {
    await expect(resolveSigner(`${base}/keys/impostor`)).rejects.toThrow(/does not list this key/);
    await expect(resolveSigner(`${base}/users/fake-alice#main-key`)).rejects.toThrow();
    expect(await resolveSigner(`${aliceId()}#main-key`)).toMatchObject({ id: aliceId(), inbox: `${aliceId()}/inbox` });
  });

  it('in production, never fetches a private address', async () => {
    const was = config.env.isProduction;
    (config.env as { isProduction: boolean }).isProduction = true;
    try {
      await expect(resolveSigner(`${aliceId()}#main-key`)).rejects.toThrow(/HTTPS|private/);
      await expect(resolveSigner('https://127.0.0.1/users/alice#main-key')).rejects.toThrow(/private/);
    } finally {
      (config.env as { isProduction: boolean }).isProduction = was;
    }
  });
});
