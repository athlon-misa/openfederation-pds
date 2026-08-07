/**
 * Private communities are PDS-local (#85, ADR-001).
 *
 * One real private community, walked across every surface an external,
 * unauthenticated consumer can reach. Each assertion is a row of the
 * enforcement map in docs/adr/ADR-001-federation-privacy.md — if a surface
 * is added to the map, its row belongs here too.
 *
 * The posture under test is existence-visible, content-stripped: a private
 * community's DID and handle are public via PLC regardless, so discovery
 * resolves — but nothing past existence (profile content, members, records,
 * repo bytes, backing AP instances) leaves the membership gate.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import {
  api, xrpcGet, xrpcAuthGet, xrpcAuthPost,
  createTestUser, isPLCAvailable, uniqueHandle,
} from './helpers.js';
import { communityFederationView } from '../../src/federation/privacy.js';

type User = { accessJwt: string; did: string; handle: string };

const SECRET_NAME = 'Clandestine Reading Circle';
const SECRET_DESC = 'A description no outsider may read';

describe('federation privacy (#85)', () => {
  let plcAvailable: boolean;
  let owner: User;
  let outsider: User;
  let communityDid: string;
  let communityHandle: string;

  beforeAll(async () => {
    plcAvailable = await isPLCAvailable();
    if (!plcAvailable) return;

    owner = await createTestUser(uniqueHandle('fp-owner'));
    outsider = await createTestUser(uniqueHandle('fp-outsider'));

    communityHandle = uniqueHandle('fp-priv');
    const created = await xrpcAuthPost('net.openfederation.community.create', owner.accessJwt, {
      handle: communityHandle,
      didMethod: 'plc',
      visibility: 'private',
      joinPolicy: 'approval',
      displayName: SECRET_NAME,
      description: SECRET_DESC,
    });
    expect(created.status).toBe(201);
    communityDid = created.body.did;

    // Link an AP application — the case that leaked before this existed: a
    // private community whose owner deliberately connected an AP instance.
    const linked = await xrpcAuthPost('net.openfederation.community.linkApplication', owner.accessJwt, {
      communityDid,
      appType: 'discourse',
      instanceUrl: 'https://secret-forum.example.test',
      displayName: 'Secret Forum',
    });
    expect(linked.status).toBe(200);
  });

  it('classifies the community as private, and a public one as public', async () => {
    if (!plcAvailable) return;
    expect(await communityFederationView(communityDid)).toBe('private');
    expect(await communityFederationView('did:plc:doesnotexistaaaaaaaaaaaa')).toBe('absent');
  });

  it('sync.getRepo refuses the repo bytes to an outsider', async () => {
    if (!plcAvailable) return;
    const anon = await api.get(`/xrpc/com.atproto.sync.getRepo?did=${encodeURIComponent(communityDid)}`);
    expect(anon.status).toBe(404);
    const authed = await xrpcAuthGet('com.atproto.sync.getRepo', outsider.accessJwt, { did: communityDid });
    expect(authed.status).toBe(404);
  });

  it('the generic repo endpoints refuse records and description', async () => {
    if (!plcAvailable) return;
    const list = await xrpcGet('com.atproto.repo.listRecords', {
      repo: communityDid, collection: 'net.openfederation.community.member',
    });
    expect(list.status).toBe(404);
    const describe = await xrpcGet('com.atproto.repo.describeRepo', { repo: communityDid });
    expect(describe.status).toBe(404);
  });

  it('listAll excludes the community for everyone but members', async () => {
    if (!plcAvailable) return;
    const anon = await xrpcGet('net.openfederation.community.listAll', {});
    expect(anon.status).toBe(200);
    const dids = (anon.body.communities ?? []).map((c: any) => c.did);
    expect(dids).not.toContain(communityDid);

    const authed = await xrpcAuthGet('net.openfederation.community.listAll', outsider.accessJwt, {});
    const authedDids = (authed.body.communities ?? []).map((c: any) => c.did);
    expect(authedDids).not.toContain(communityDid);
  });

  it('listMembers refuses an outsider', async () => {
    if (!plcAvailable) return;
    const res = await xrpcAuthGet('net.openfederation.community.listMembers', outsider.accessJwt, { did: communityDid });
    expect([403, 404]).toContain(res.status);
  });

  it('the AP actor exists but is stripped of everything past existence', async () => {
    if (!plcAvailable) return;
    const res = await api.get(`/ap/actor/${communityDid}`);
    expect(res.status).toBe(200);

    const body = res.text;
    // The leak this guards against: name, description and backing instance
    // were all served to anyone with the DID.
    expect(body).not.toContain(SECRET_NAME);
    expect(body).not.toContain(SECRET_DESC);
    expect(body).not.toContain('secret-forum.example.test');

    // ...while the actor still functions for the integration the owner
    // deliberately linked: identity and signature key remain.
    const actor = JSON.parse(body);
    expect(actor.id).toContain(communityDid);
    expect(actor.publicKey?.publicKeyPem).toContain('BEGIN PUBLIC KEY');
  });

  it('webfinger resolves existence but advertises no content links', async () => {
    if (!plcAvailable) return;
    const res = await api.get(`/.well-known/webfinger?resource=${encodeURIComponent(`did:${communityDid.slice(4)}`)}`)
      .then(r => r.status === 200 ? r : api.get(`/.well-known/webfinger?resource=${encodeURIComponent(communityDid)}`));
    expect(res.status).toBe(200);

    const rels = (res.body.links ?? []).map((l: any) => l.rel);
    expect(rels).not.toContain('http://webfinger.net/rel/profile-page');
    expect(JSON.stringify(res.body)).not.toContain(SECRET_NAME);
  });

  it('a public community keeps its full actor and links — the strip is not a blanket', async () => {
    if (!plcAvailable) return;
    const pubHandle = uniqueHandle('fp-pub');
    const created = await xrpcAuthPost('net.openfederation.community.create', owner.accessJwt, {
      handle: pubHandle, didMethod: 'plc', visibility: 'public', joinPolicy: 'open',
      displayName: 'Open Reading Circle',
    });
    const pubDid = created.body.did;
    await xrpcAuthPost('net.openfederation.community.linkApplication', owner.accessJwt, {
      communityDid: pubDid, appType: 'discourse',
      instanceUrl: 'https://open-forum.example.test', displayName: 'Open Forum',
    });

    const actor = await api.get(`/ap/actor/${pubDid}`);
    expect(actor.status).toBe(200);
    expect(actor.text).toContain('Open Reading Circle');
    expect(actor.text).toContain('open-forum.example.test');

    const wf = await api.get(`/.well-known/webfinger?resource=${encodeURIComponent(pubDid)}`);
    expect(wf.status).toBe(200);
    const rels = (wf.body.links ?? []).map((l: any) => l.rel);
    expect(rels).toContain('http://webfinger.net/rel/profile-page');

    const list = await xrpcGet('net.openfederation.community.listAll', {});
    expect((list.body.communities ?? []).map((c: any) => c.did)).toContain(pubDid);
  });

  it('members still see everything — the gate is membership, not privacy theater', async () => {
    if (!plcAvailable) return;
    const res = await xrpcAuthGet('net.openfederation.community.listMembers', owner.accessJwt, { did: communityDid });
    expect(res.status).toBe(200);
    expect(res.body.members.some((m: any) => m.did === owner.did)).toBe(true);
  });
});
