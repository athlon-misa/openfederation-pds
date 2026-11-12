/**
 * ActivityPub interoperability, checked by real ActivityPub software (#80).
 *
 * activitypub-discovery.test.ts re-implements Mastodon's acceptance checks by
 * hand. This file asks established implementations instead:
 *
 *  - Fedify (@fedify/vocab, @fedify/webfinger) — the AP framework behind
 *    Hollo, Ghost's ActivityPub service and others — discovers the community
 *    over real HTTP: WebFinger `acct:` lookup, then the actor, then its key
 *    and collections, parsed as JSON-LD into its vocabulary types.
 *  - jsonld.js expands the actor against the ActivityStreams and security
 *    contexts, so every term we serve must mean what Mastodon reads it as.
 *  - Ajv validates NodeInfo against the published 2.1 JSON schema, vendored
 *    in tests/api/fixtures (AP_LIVE_TEST=1 compares it with the live copy).
 *
 * AP_LIVE_TEST=1 also runs the same checks, read-only (GET), against
 * production https://pds.openfederation.net.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import { readFileSync } from 'fs';
import { lookupObject, isActor, Group, PropertyValue, CryptographicKey, OrderedCollection } from '@fedify/vocab';
import { lookupWebFinger } from '@fedify/webfinger';
import { getDocumentLoader, preloadedContexts } from '@fedify/vocab-runtime';
// @ts-expect-error jsonld ships no types
import jsonld from 'jsonld';
import Ajv from 'ajv-draft-04';
import {
  api, xrpcAuthPost, createTestUser, isPLCAvailable, uniqueHandle,
} from './helpers.js';
import { config } from '../../src/config.js';

const LIVE = process.env.AP_LIVE_TEST === '1';
const PRODUCTION = 'https://pds.openfederation.net';
const WEB_UI = 'https://web.example.test';

const AS = 'https://www.w3.org/ns/activitystreams#';
const SEC = 'https://w3id.org/security#';
const LDP_INBOX = 'http://www.w3.org/ns/ldp#inbox';

const nodeinfoSchema = JSON.parse(
  readFileSync(new URL('./fixtures/nodeinfo-2.1.schema.json', import.meta.url), 'utf-8'),
);

/** Offline JSON-LD context loader: only the contexts Fedify ships. */
async function contextLoader(url: string) {
  const document = (preloadedContexts as Record<string, unknown>)[url];
  if (!document) throw new Error(`context not preloaded: ${url}`);
  return { contextUrl: null, documentUrl: url, document };
}

async function expand(doc: unknown): Promise<any[]> {
  return jsonld.expand(doc, { documentLoader: contextLoader });
}

/** Fedify options for talking to the test server on 127.0.0.1. */
const localLoader = getDocumentLoader({ allowPrivateAddress: true });
const localLookup = {
  documentLoader: localLoader,
  contextLoader: localLoader,
  crossOrigin: 'throw' as const,
  allowPrivateAddress: true,
};

describe('ActivityPub interop with real AP software (#80)', () => {
  let plcAvailable: boolean;
  let host: string;
  let communityDid: string;
  let communityHandle: string;
  let actorUrl: string;
  let rawActor: any;
  let previousWebUi: string;
  const realFetch = globalThis.fetch;

  beforeAll(async () => {
    host = new URL(config.pds.serviceUrl).host;
    previousWebUi = config.federation.webUiUrl;
    config.federation.webUiUrl = WEB_UI;

    // WebFinger for an `acct:` resource is always https (RFC 7033 §4). The
    // test server speaks plain http, so stand in for the TLS terminator that
    // sits in front of it in production.
    const httpsOrigin = `https://${host}`;
    globalThis.fetch = ((input: any, init?: any) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith(`${httpsOrigin}/`)) {
        const rewritten = `http://${host}${url.slice(httpsOrigin.length)}`;
        return realFetch(typeof input === 'string' || input instanceof URL ? rewritten : new Request(rewritten, input), init);
      }
      return realFetch(input, init);
    }) as typeof fetch;

    plcAvailable = await isPLCAvailable();
    if (!plcAvailable) return;

    const owner = await createTestUser(uniqueHandle('apx-owner'));
    communityHandle = uniqueHandle('apx-comm');
    const created = await xrpcAuthPost('net.openfederation.community.create', owner.accessJwt, {
      handle: communityHandle,
      didMethod: 'plc',
      visibility: 'public',
      joinPolicy: 'open',
      displayName: 'Interop Reading Circle',
      description: 'Discovered by Fedify',
    });
    expect(created.status).toBe(201);
    communityDid = created.body.did;

    const linked = await xrpcAuthPost('net.openfederation.community.linkApplication', owner.accessJwt, {
      communityDid,
      appType: 'mastodon',
      instanceUrl: 'https://mastodon.example.test',
      displayName: 'Example <Mastodon>',
    });
    expect(linked.status).toBe(200);
    actorUrl = `${config.pds.serviceUrl}/ap/actor/${communityDid}`;
    rawActor = JSON.parse((await api.get(`/ap/actor/${communityDid}`)
      .set('Accept', 'application/activity+json')).text);
  });

  afterAll(() => {
    globalThis.fetch = realFetch;
    config.federation.webUiUrl = previousWebUi;
  });

  describe('WebFinger (RFC 7033)', () => {
    it('Fedify\'s WebFinger client resolves the acct: handle to the actor', async () => {
      if (!plcAvailable) return;
      const jrd = await lookupWebFinger(`acct:${communityHandle}@${host}`, { allowPrivateAddress: true });
      expect(jrd).not.toBeNull();
      expect(jrd!.subject).toBe(`acct:${communityHandle}@${host}`);
      const self = jrd!.links?.find((l) => l.rel === 'self' && l.type === 'application/activity+json');
      expect(self?.href).toBe(actorUrl);
    });

    it('is served as application/jrd+json with Access-Control-Allow-Origin: * (RFC 7033 §5)', async () => {
      if (!plcAvailable) return;
      const res = await api.get(`/.well-known/webfinger?resource=${encodeURIComponent(`acct:${communityHandle}@${host}`)}`)
        .set('Origin', 'https://some-browser-client.example');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/^application\/jrd\+json/);
      expect(res.headers['access-control-allow-origin']).toBe('*');
    });

    it('an unknown account is a 404 (which Fedify reports as not found)', async () => {
      const jrd = await lookupWebFinger(`acct:nobody-${Date.now()}@${host}`, { allowPrivateAddress: true });
      expect(jrd).toBeNull();
    });

    it('the profile-page link points at the web UI, where the page exists', async () => {
      if (!plcAvailable) return;
      const jrd = await lookupWebFinger(`acct:${communityHandle}@${host}`, { allowPrivateAddress: true });
      const profile = jrd!.links?.find((l) => l.rel === 'http://webfinger.net/rel/profile-page');
      expect(profile).toEqual({
        rel: 'http://webfinger.net/rel/profile-page',
        type: 'text/html',
        href: `${WEB_UI}/communities/${communityDid}`,
      });
    });
  });

  describe('actor, as Fedify parses it', () => {
    let group: Group;

    it('lookupObject("@handle@host") follows WebFinger and returns a Group actor', async () => {
      if (!plcAvailable) return;
      const object = await lookupObject(`@${communityHandle}@${host}`, localLookup as any);
      expect(object).toBeInstanceOf(Group);
      expect(isActor(object)).toBe(true);
      group = object as Group;

      expect(group.id?.href).toBe(actorUrl);
      expect(group.preferredUsername?.toString()).toBe(communityHandle);
      expect(group.name?.toString()).toBe('Interop Reading Circle');
      expect(group.summary?.toString()).toBe('Discovered by Fedify');
      expect(group.url?.href ?? (group.url as any)?.href?.href).toBe(`${WEB_UI}/communities/${communityDid}`);
      expect(group.inboxId?.href).toBe(`${actorUrl}/inbox`);
      expect(group.outboxId?.href).toBe(`${actorUrl}/outbox`);
      expect(group.published).toBeTruthy();
    });

    it('looking up the actor URL directly gives the same actor', async () => {
      if (!plcAvailable) return;
      const object = await lookupObject(actorUrl, localLookup as any);
      expect(object).toBeInstanceOf(Group);
      expect(object!.id?.href).toBe(actorUrl);
    });

    it('the public key is a CryptographicKey owned by the actor that imports as RSA', async () => {
      if (!plcAvailable) return;
      const key = await group.getPublicKey({ documentLoader: localLoader, contextLoader: localLoader });
      expect(key).toBeInstanceOf(CryptographicKey);
      expect(key!.id?.href).toBe(`${actorUrl}#main-key`);
      expect(key!.ownerId?.href).toBe(actorUrl);
      // Fedify imports publicKeyPem into a WebCrypto key: the PEM parsed as SPKI.
      expect(key!.publicKey?.type).toBe('public');
      expect(key!.publicKey?.algorithm.name).toBe('RSASSA-PKCS1-v1_5');
    });

    it('inbox and outbox dereference to empty OrderedCollections', async () => {
      if (!plcAvailable) return;
      const opts = { documentLoader: localLoader, contextLoader: localLoader };
      const inbox = await group.getInbox(opts);
      const outbox = await group.getOutbox(opts);
      for (const box of [inbox, outbox]) {
        expect(box).toBeInstanceOf(OrderedCollection);
        expect(box!.totalItems).toBe(0);
      }
    });

    it('linked applications survive JSON-LD parsing as PropertyValue attachments', async () => {
      if (!plcAvailable) return;
      const attachments = [];
      for await (const a of group.getAttachments({ documentLoader: localLoader, contextLoader: localLoader })) {
        attachments.push(a);
      }
      expect(attachments).toHaveLength(1);
      expect(attachments[0]).toBeInstanceOf(PropertyValue);
      const pv = attachments[0] as PropertyValue;
      expect(pv.name?.toString()).toBe('mastodon');
      expect(pv.value?.toString()).toBe('<a href="https://mastodon.example.test/">Example &lt;Mastodon&gt;</a>');
    });
  });

  describe('actor, as JSON-LD', () => {
    it('every term expands to the ActivityStreams / security IRI Mastodon reads', async () => {
      if (!plcAvailable) return;
      const [node] = await expand(rawActor);
      expect(node['@id']).toBe(actorUrl);
      expect(node['@type']).toEqual([`${AS}Group`]);
      expect(node[`${AS}preferredUsername`]).toEqual([{ '@value': communityHandle }]);
      expect(node[`${AS}name`]).toEqual([{ '@value': 'Interop Reading Circle' }]);
      expect(node[`${AS}summary`]).toEqual([{ '@value': 'Discovered by Fedify' }]);
      expect(node[`${AS}url`]).toEqual([{ '@id': `${WEB_UI}/communities/${communityDid}` }]);
      expect(node[LDP_INBOX]).toEqual([{ '@id': `${actorUrl}/inbox` }]);
      expect(node[`${AS}outbox`]).toEqual([{ '@id': `${actorUrl}/outbox` }]);
      expect(node[`${AS}published`]?.[0]?.['@type']).toBe('http://www.w3.org/2001/XMLSchema#dateTime');

      const [key] = node[`${SEC}publicKey`];
      expect(key['@id']).toBe(`${actorUrl}#main-key`);
      expect(key[`${SEC}owner`]).toEqual([{ '@id': actorUrl }]);
      const pem = key[`${SEC}publicKeyPem`][0]['@value'];
      const parsed = crypto.createPublicKey({ key: pem, format: 'pem', type: 'spki' });
      expect(parsed.asymmetricKeyType).toBe('rsa');
    });

    it('the attachment keeps its type and value through expansion', async () => {
      if (!plcAvailable) return;
      const [node] = await expand(rawActor);
      const [att] = node[`${AS}attachment`];
      expect(att['@type']).toEqual(['http://schema.org#PropertyValue']);
      expect(att['http://schema.org#value']?.[0]?.['@value']).toContain('https://mastodon.example.test/');
    });

    it('every term we serve is defined by a context we declare', async () => {
      if (!plcAvailable) return;
      // The ActivityStreams context sets "@vocab": "_:", so a term no context
      // defines expands to a blank-node IRI ("_:value") instead of being
      // dropped — and a JSON-LD consumer cannot interpret it.
      const undefinedTerms = new Set<string>();
      const walk = (node: unknown): void => {
        if (Array.isArray(node)) { node.forEach(walk); return; }
        if (!node || typeof node !== 'object') return;
        for (const [key, value] of Object.entries(node)) {
          if (key.startsWith('_:')) undefinedTerms.add(key);
          if (key === '@type') for (const t of value as string[]) if (t.startsWith('_:')) undefinedTerms.add(t);
          walk(value);
        }
      };
      walk(await expand(rawActor));
      expect([...undefinedTerms]).toEqual([]);
    });
  });

  describe('without a web UI configured', () => {
    it('the actor has no url and WebFinger no profile-page link, rather than a link to a page that does not exist', async () => {
      if (!plcAvailable) return;
      config.federation.webUiUrl = '';
      try {
        const actor = JSON.parse((await api.get(`/ap/actor/${communityDid}`)).text);
        expect(actor).not.toHaveProperty('url');
        const wf = await api.get(`/.well-known/webfinger?resource=${encodeURIComponent(communityDid)}`);
        expect(wf.body.links.map((l: any) => l.rel)).not.toContain('http://webfinger.net/rel/profile-page');
        // Fedify still accepts the actor.
        expect(await lookupObject(actorUrl, localLookup as any)).toBeInstanceOf(Group);
      } finally {
        config.federation.webUiUrl = WEB_UI;
      }
    });
  });

  describe('NodeInfo 2.1', () => {
    const ajv = new Ajv({ allErrors: true });
    const validate = ajv.compile(nodeinfoSchema);

    it('/.well-known/nodeinfo has the 2.1 schema rel and an absolute href, with CORS', async () => {
      const res = await api.get('/.well-known/nodeinfo').set('Origin', 'https://some-browser-client.example');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/^application\/(jrd\+)?json/);
      expect(res.headers['access-control-allow-origin']).toBe('*');
      const link = res.body.links.find((l: any) => l.rel === 'http://nodeinfo.diaspora.software/ns/schema/2.1');
      expect(link.href).toBe(`${config.pds.serviceUrl}/nodeinfo/2.1`);
    });

    it('/nodeinfo/2.1 validates against the published JSON schema', async () => {
      const res = await api.get('/nodeinfo/2.1').set('Origin', 'https://some-browser-client.example');
      expect(res.status).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBe('*');
      const doc = JSON.parse(res.text);
      const ok = validate(doc);
      expect(validate.errors ?? []).toEqual([]);
      expect(ok).toBe(true);
    });

    it('the schema validator is not vacuous: it rejects AT Protocol in `protocols`', () => {
      expect(validate({
        version: '2.1', software: { name: 'x', version: '1' }, protocols: ['atprotocol'],
        services: { inbound: [], outbound: [] }, openRegistrations: false,
        usage: { users: {} }, metadata: {},
      })).toBe(false);
    });
  });

  describe.runIf(LIVE)('production, read-only (AP_LIVE_TEST=1)', () => {
    const prodLookup = { crossOrigin: 'throw' as const };

    it('the vendored NodeInfo schema matches the published one', async () => {
      const res = await realFetch('http://nodeinfo.diaspora.software/ns/schema/2.1');
      expect(res.ok).toBe(true);
      expect(await res.json()).toEqual(nodeinfoSchema);
    });

    it('production NodeInfo validates against the schema', async () => {
      const wk = await (await realFetch(`${PRODUCTION}/.well-known/nodeinfo`)).json();
      const href = wk.links.find((l: any) => l.rel === 'http://nodeinfo.diaspora.software/ns/schema/2.1').href;
      const doc = await (await realFetch(href)).json();
      const validate = new Ajv({ allErrors: true }).compile(nodeinfoSchema);
      validate(doc);
      expect(validate.errors ?? []).toEqual([]);
    });

    it('every public production community with linked apps is a Group that Fedify accepts', async () => {
      const list = await (await realFetch(`${PRODUCTION}/xrpc/net.openfederation.community.listAll?limit=100`)).json();
      const host = new URL(PRODUCTION).host;
      const linked: string[] = [];
      for (const c of list.communities) {
        const apps = await (await realFetch(
          `${PRODUCTION}/xrpc/net.openfederation.community.listApplications?did=${encodeURIComponent(c.did)}`,
        )).json();
        const actorStatus = (await realFetch(`${PRODUCTION}/ap/actor/${c.did}`)).status;
        if (apps.applications.length === 0) {
          // No linked app, no actor: WebFinger must not advertise one either.
          expect(actorStatus).toBe(404);
          const jrd = await lookupWebFinger(`acct:${c.handle}@${host}`);
          expect(jrd?.links?.some((l) => l.type === 'application/activity+json')).toBe(false);
          continue;
        }
        linked.push(c.handle);
        expect(actorStatus).toBe(200);
        const object = await lookupObject(`@${c.handle}@${host}`, prodLookup);
        expect(object).toBeInstanceOf(Group);
        expect((object as Group).inboxId).toBeTruthy();
        expect(await (object as Group).getPublicKey()).toBeInstanceOf(CryptographicKey);
      }
      console.log(`[AP_LIVE_TEST] ${list.communities.length} public communities on ${PRODUCTION}; with linked applications: ${linked.length ? linked.join(', ') : 'none'}`);
    });
  });
});
