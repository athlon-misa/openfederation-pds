/**
 * ActivityPub discovery, validated end to end (#80).
 *
 * A public community links a Mastodon instance, and an AP client then
 * discovers it the way Mastodon does: WebFinger `acct:` lookup → follow the
 * activity+json `self` link → fetch the actor → check it back against
 * WebFinger. The checks mirror the ones Mastodon applies before it accepts a
 * remote actor (ActivityPub::FetchRemoteActorService / ProcessAccountService):
 * a supported @context and actor type, `id` equal to the URL fetched, a
 * non-empty `preferredUsername` that resolves back to the same actor, an
 * `inbox`, and an RSA public key owned by the actor.
 *
 * NodeInfo is checked against the NodeInfo 2.1 schema's required fields and
 * closed enums (http://nodeinfo.diaspora.software/ns/schema/2.1).
 *
 * Private-community stripping is covered by federation-privacy.test.ts.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import crypto from 'crypto';
import {
  api, xrpcGet, xrpcAuthPost, createTestUser, isPLCAvailable, uniqueHandle,
} from './helpers.js';
import { config } from '../../src/config.js';
import { query } from '../../src/db/client.js';

type User = { accessJwt: string; did: string; handle: string };

// Mastodon's ActivityPub::FetchRemoteActorService::SUPPORTED_TYPES
const MASTODON_ACTOR_TYPES = ['Application', 'Group', 'Organization', 'Person', 'Service'];
// What Mastodon sends when it fetches an actor.
const AP_ACCEPT = 'application/activity+json, application/ld+json; profile="https://www.w3.org/ns/activitystreams"';

// NodeInfo 2.1 schema: closed enums.
const NODEINFO_PROTOCOLS = ['activitypub', 'buddycloud', 'dfrn', 'diaspora', 'libertree', 'ostatus', 'pumpio', 'tent', 'xmpp', 'zot'];
const NODEINFO_INBOUND = ['atom1.0', 'gnusocial', 'imap', 'pnut', 'pop3', 'pumpio', 'rss2.0', 'twitter'];
const NODEINFO_OUTBOUND = ['atom1.0', 'blogger', 'buddycloud', 'diaspora', 'dreamwidth', 'drupal', 'facebook', 'friendica',
  'gnusocial', 'google', 'insanejournal', 'libertree', 'linkedin', 'livejournal', 'mediagoblin', 'myspace', 'pinterest',
  'pnut', 'posterous', 'pumpio', 'redmatrix', 'rss2.0', 'smtp', 'tent', 'tumblr', 'twitter', 'wordpress', 'xmpp'];

function host(): string {
  return new URL(config.pds.serviceUrl).host;
}

/** The path of a URL on this server, for supertest. */
function localPath(url: string): string {
  const u = new URL(url);
  expect(u.origin).toBe(new URL(config.pds.serviceUrl).origin);
  return u.pathname + u.search;
}

async function webfinger(resource: string) {
  return api.get(`/.well-known/webfinger?resource=${encodeURIComponent(resource)}`);
}

function apSelfLink(body: any): string | undefined {
  return (body.links ?? []).find((l: any) => l.rel === 'self' && l.type === 'application/activity+json')?.href;
}

describe('ActivityPub discovery (#80)', () => {
  let plcAvailable: boolean;
  let owner: User;
  let member: User;
  let communityDid: string;
  let communityHandle: string;
  let linkedRkey: string;

  beforeAll(async () => {
    plcAvailable = await isPLCAvailable();
    if (!plcAvailable) return;

    owner = await createTestUser(uniqueHandle('ap-owner'));
    member = await createTestUser(uniqueHandle('ap-member'));

    communityHandle = uniqueHandle('ap-comm');
    const created = await xrpcAuthPost('net.openfederation.community.create', owner.accessJwt, {
      handle: communityHandle,
      didMethod: 'plc',
      visibility: 'public',
      joinPolicy: 'open',
      displayName: 'AP Reading Circle',
      description: 'A community with a Mastodon instance',
    });
    expect(created.status).toBe(201);
    communityDid = created.body.did;

    const joined = await xrpcAuthPost('net.openfederation.community.join', member.accessJwt, { did: communityDid });
    expect(joined.status).toBeLessThan(300);
  });

  describe('linkApplication + listApplications', () => {
    it('has no actor before anything is linked, and WebFinger advertises none', async () => {
      if (!plcAvailable) return;
      const actor = await api.get(`/ap/actor/${communityDid}`);
      expect(actor.status).toBe(404);

      const wf = await webfinger(`acct:${communityHandle}@${host()}`);
      expect(wf.status).toBe(200);
      expect(apSelfLink(wf.body)).toBeUndefined();
      // The DID link is always there.
      expect(wf.body.links).toContainEqual({ rel: 'self', type: 'application/json', href: communityDid });
    });

    it('links a Mastodon instance as a signed repo record, and audits it', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthPost('net.openfederation.community.linkApplication', owner.accessJwt, {
        communityDid,
        appType: 'mastodon',
        instanceUrl: 'https://mastodon.example.test',
        displayName: 'Example Mastodon',
      });
      expect(res.status).toBe(200);
      expect(res.body.uri).toBe(`at://${communityDid}/net.openfederation.community.application/${res.body.rkey}`);
      expect(res.body.appType).toBe('mastodon');
      expect(res.body.instanceUrl).toBe('https://mastodon.example.test/');
      expect(res.body.displayName).toBe('Example Mastodon');
      linkedRkey = res.body.rkey;

      const audit = await query<{ meta: any }>(
        `SELECT meta FROM audit_log WHERE action = 'community.linkApplication' AND target_id = $1`,
        [communityDid],
      );
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0].meta).toMatchObject({ appType: 'mastodon', rkey: linkedRkey });
    });

    it('listApplications returns the linked application with who linked it', async () => {
      if (!plcAvailable) return;
      const res = await xrpcGet('net.openfederation.community.listApplications', { did: communityDid });
      expect(res.status).toBe(200);
      expect(res.body.applications).toHaveLength(1);
      const [app] = res.body.applications;
      expect(app).toMatchObject({
        uri: `at://${communityDid}/net.openfederation.community.application/${linkedRkey}`,
        rkey: linkedRkey,
        appType: 'mastodon',
        instanceUrl: 'https://mastodon.example.test/',
        displayName: 'Example Mastodon',
        linkedBy: owner.did,
      });
      expect(app.cid).toBeTruthy();
      expect(Number.isNaN(Date.parse(app.linkedAt))).toBe(false);
    });

    it('the link is a record in the community repo, readable through com.atproto.repo.getRecord', async () => {
      if (!plcAvailable) return;
      const res = await xrpcGet('com.atproto.repo.getRecord', {
        repo: communityDid, collection: 'net.openfederation.community.application', rkey: linkedRkey,
      });
      expect(res.status).toBe(200);
      expect(res.body.value.$type).toBe('net.openfederation.community.application');
      expect(res.body.value.instanceUrl).toBe('https://mastodon.example.test/');
    });

    it('refuses a duplicate instance, a non-HTTPS URL and an unknown app type', async () => {
      if (!plcAvailable) return;
      const dup = await xrpcAuthPost('net.openfederation.community.linkApplication', owner.accessJwt, {
        communityDid, appType: 'mastodon', instanceUrl: 'https://mastodon.example.test/',
      });
      expect(dup.status).toBe(409);

      const http = await xrpcAuthPost('net.openfederation.community.linkApplication', owner.accessJwt, {
        communityDid, appType: 'mastodon', instanceUrl: 'http://insecure.example.test',
      });
      expect(http.status).toBe(400);

      const type = await xrpcAuthPost('net.openfederation.community.linkApplication', owner.accessJwt, {
        communityDid, appType: 'myspace', instanceUrl: 'https://x.example.test',
      });
      expect(type.status).toBe(400);
    });

    it('a plain member cannot link or unlink', async () => {
      if (!plcAvailable) return;
      const link = await xrpcAuthPost('net.openfederation.community.linkApplication', member.accessJwt, {
        communityDid, appType: 'matrix', instanceUrl: 'https://matrix.example.test',
      });
      expect(link.status).toBe(403);
      const unlink = await xrpcAuthPost('net.openfederation.community.unlinkApplication', member.accessJwt, {
        communityDid, rkey: linkedRkey,
      });
      expect(unlink.status).toBe(403);
    });
  });

  describe('Mastodon discovery flow', () => {
    let actorUrl: string;
    let actor: any;

    it('WebFinger acct: lookup returns a well-formed JRD pointing at the actor', async () => {
      if (!plcAvailable) return;
      const resource = `acct:${communityHandle}@${host()}`;
      const wf = await webfinger(resource);
      expect(wf.status).toBe(200);
      expect(wf.headers['content-type']).toMatch(/^application\/jrd\+json/);
      expect(wf.body.subject).toBe(resource);
      for (const link of wf.body.links) {
        expect(typeof link.rel).toBe('string');
        expect(typeof link.href).toBe('string');
      }
      const self = apSelfLink(wf.body);
      expect(self).toBe(`${config.pds.serviceUrl}/ap/actor/${communityDid}`);
      actorUrl = self!;

      const profile = wf.body.links.find((l: any) => l.rel === 'http://webfinger.net/rel/profile-page');
      expect(profile?.type).toBe('text/html');
    });

    it('the actor fetched with Mastodon\'s Accept header is an actor Mastodon accepts', async () => {
      if (!plcAvailable) return;
      const res = await api.get(localPath(actorUrl)).set('Accept', AP_ACCEPT);
      expect(res.status).toBe(200);
      // Mastodon only parses an AP body served as activity+json or ld+json.
      expect(res.headers['content-type']).toMatch(/^application\/activity\+json/);
      actor = JSON.parse(res.text);

      // supported_context?
      const ctx = Array.isArray(actor['@context']) ? actor['@context'] : [actor['@context']];
      expect(ctx).toContain('https://www.w3.org/ns/activitystreams');
      // expected_type?
      expect(MASTODON_ACTOR_TYPES).toContain(actor.type);
      // id must be the URL that was fetched, on the same host
      expect(actor.id).toBe(actorUrl);
      // "has no 'preferredUsername', which is a requirement for Mastodon compatibility"
      expect(actor.preferredUsername).toBe(communityHandle);
      // ProcessAccountService returns early when inbox is blank; ActivityPub §4.1
      // requires inbox and outbox on every actor.
      expect(typeof actor.inbox).toBe('string');
      expect(typeof actor.outbox).toBe('string');
      expect(actor.name).toBe('AP Reading Circle');
      expect(actor.summary).toBe('A community with a Mastodon instance');
      expect(Number.isNaN(Date.parse(actor.published))).toBe(false);
    });

    it('preferredUsername resolves back to the same actor (Mastodon\'s check_webfinger!)', async () => {
      if (!plcAvailable) return;
      const actorHost = new URL(actor.id).host;
      const wf = await webfinger(`acct:${actor.preferredUsername}@${actorHost}`);
      expect(wf.status).toBe(200);
      expect(apSelfLink(wf.body)).toBe(actor.id);
    });

    it('the public key is an RSA key owned by the actor, stable across fetches', async () => {
      if (!plcAvailable) return;
      expect(actor.publicKey.id).toBe(`${actor.id}#main-key`);
      expect(actor.publicKey.owner).toBe(actor.id);
      const key = crypto.createPublicKey(actor.publicKey.publicKeyPem);
      expect(key.asymmetricKeyType).toBe('rsa');
      expect(key.asymmetricKeyDetails?.modulusLength).toBeGreaterThanOrEqual(2048);

      const again = await api.get(localPath(actor.id)).set('Accept', AP_ACCEPT);
      expect(JSON.parse(again.text).publicKey.publicKeyPem).toBe(actor.publicKey.publicKeyPem);

      // Persisted, with the private half encrypted at rest.
      const stored = await query<{ public_key_pem: string; encrypted_private_key: Buffer }>(
        'SELECT public_key_pem, encrypted_private_key FROM ap_signing_keys WHERE did = $1', [communityDid],
      );
      expect(stored.rows[0].public_key_pem).toBe(actor.publicKey.publicKeyPem);
      expect(stored.rows[0].encrypted_private_key.toString('utf-8')).not.toContain('PRIVATE KEY');
    });

    it('lists the linked instance as a PropertyValue attachment, HTML-escaped', async () => {
      if (!plcAvailable) return;
      expect(actor.attachment).toEqual([{
        type: 'PropertyValue',
        name: 'mastodon',
        value: '<a href="https://mastodon.example.test/">Example Mastodon</a>',
      }]);
    });

    it('inbox and outbox are empty OrderedCollections; deliveries are refused with a final 4xx', async () => {
      if (!plcAvailable) return;
      for (const url of [actor.inbox, actor.outbox]) {
        const res = await api.get(localPath(url)).set('Accept', AP_ACCEPT);
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toMatch(/^application\/activity\+json/);
        const body = JSON.parse(res.text);
        expect(body).toMatchObject({ id: url, type: 'OrderedCollection', totalItems: 0, orderedItems: [] });
      }

      const delivery = await api.post(localPath(actor.inbox))
        .set('Content-Type', 'application/activity+json')
        .send(JSON.stringify({
          '@context': 'https://www.w3.org/ns/activitystreams',
          type: 'Follow', actor: 'https://mastodon.example.test/users/alice', object: actor.id,
        }));
      expect(delivery.status).toBe(405);
    });

    it('verifyMembership answers an AP app with a boolean and a role', async () => {
      if (!plcAvailable) return;
      const yes = await xrpcGet('net.openfederation.community.verifyMembership', {
        communityDid, memberDid: member.did,
      });
      expect(yes.status).toBe(200);
      expect(yes.body).toEqual({ isMember: true, role: 'member' });

      const ownerRes = await xrpcGet('net.openfederation.community.verifyMembership', {
        communityDid, memberDid: owner.did,
      });
      expect(ownerRes.body).toEqual({ isMember: true, role: 'owner' });

      const no = await xrpcGet('net.openfederation.community.verifyMembership', {
        communityDid, memberDid: 'did:plc:notamemberaaaaaaaaaaaaaa',
      });
      expect(no.status).toBe(200);
      expect(no.body).toEqual({ isMember: false });
    });
  });

  describe('where no actor exists', () => {
    it('WebFinger for a user advertises no ActivityPub actor', async () => {
      if (!plcAvailable) return;
      const bareHandle = member.handle.split('.')[0];
      const byDid = await webfinger(member.did);
      expect(byDid.status).toBe(200);
      expect(apSelfLink(byDid.body)).toBeUndefined();

      const byAcct = await webfinger(`acct:${bareHandle}@${host()}`);
      if (byAcct.status === 200) expect(apSelfLink(byAcct.body)).toBeUndefined();
    });

    it('an unknown or malformed DID has no actor and no inbox', async () => {
      const missing = await api.get('/ap/actor/did:plc:doesnotexistaaaaaaaaaaaa');
      expect(missing.status).toBe(404);
      const inbox = await api.get('/ap/actor/did:plc:doesnotexistaaaaaaaaaaaa/inbox');
      expect(inbox.status).toBe(404);
      const bad = await api.get('/ap/actor/not-a-did');
      expect(bad.status).toBe(400);
    });

    it('a suspended community loses its actor and its WebFinger actor link', async () => {
      if (!plcAvailable) return;
      await query(`UPDATE communities SET status = 'suspended' WHERE did = $1`, [communityDid]);
      try {
        expect((await api.get(`/ap/actor/${communityDid}`)).status).toBe(404);
        expect((await api.get(`/ap/actor/${communityDid}/outbox`)).status).toBe(404);
        const wf = await webfinger(communityDid);
        expect(apSelfLink(wf.body)).toBeUndefined();
      } finally {
        await query(`UPDATE communities SET status = 'active' WHERE did = $1`, [communityDid]);
      }
    });

    it('unlinking the last application removes the actor and audits it', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthPost('net.openfederation.community.unlinkApplication', owner.accessJwt, {
        communityDid, rkey: linkedRkey,
      });
      expect(res.status).toBe(200);

      const list = await xrpcGet('net.openfederation.community.listApplications', { did: communityDid });
      expect(list.body.applications).toEqual([]);
      expect((await api.get(`/ap/actor/${communityDid}`)).status).toBe(404);
      expect(apSelfLink((await webfinger(communityDid)).body)).toBeUndefined();

      const audit = await query(
        `SELECT 1 FROM audit_log WHERE action = 'community.unlinkApplication' AND target_id = $1`, [communityDid],
      );
      expect(audit.rows).toHaveLength(1);
    });
  });

  describe('NodeInfo 2.1', () => {
    it('/.well-known/nodeinfo links the 2.1 document', async () => {
      const res = await api.get('/.well-known/nodeinfo');
      expect(res.status).toBe(200);
      expect(res.body.links).toContainEqual({
        rel: 'http://nodeinfo.diaspora.software/ns/schema/2.1',
        href: `${config.pds.serviceUrl}/nodeinfo/2.1`,
      });
    });

    it('/nodeinfo/2.1 conforms to the 2.1 schema', async () => {
      const res = await api.get('/nodeinfo/2.1');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('application/json');
      expect(res.headers['content-type']).toContain('profile="http://nodeinfo.diaspora.software/ns/schema/2.1#"');
      const doc = JSON.parse(res.text);

      const allowedTop = ['version', 'software', 'protocols', 'services', 'openRegistrations', 'usage', 'metadata'];
      for (const key of Object.keys(doc)) expect(allowedTop).toContain(key);
      for (const key of allowedTop) expect(doc, key).toHaveProperty(key);

      expect(doc.version).toBe('2.1');
      expect(doc.software.name).toMatch(/^[a-z0-9-]+$/);
      expect(typeof doc.software.version).toBe('string');

      expect(Array.isArray(doc.protocols)).toBe(true);
      expect(doc.protocols.length).toBeGreaterThanOrEqual(1);
      for (const p of doc.protocols) expect(NODEINFO_PROTOCOLS).toContain(p);
      expect(doc.protocols).toContain('activitypub');

      for (const s of doc.services.inbound) expect(NODEINFO_INBOUND).toContain(s);
      for (const s of doc.services.outbound) expect(NODEINFO_OUTBOUND).toContain(s);

      expect(typeof doc.openRegistrations).toBe('boolean');
      expect(Number.isInteger(doc.usage.users.total)).toBe(true);
      expect(doc.usage.users.total).toBeGreaterThanOrEqual(0);
      if (doc.usage.localPosts !== undefined) expect(Number.isInteger(doc.usage.localPosts)).toBe(true);
      expect(typeof doc.metadata).toBe('object');

      // AT Protocol is declared where the schema allows free-form data.
      expect(doc.metadata.protocols).toContain('atprotocol');
    });
  });
});
