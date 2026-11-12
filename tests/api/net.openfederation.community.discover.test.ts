/**
 * Cross-server community discovery (#41).
 *
 * This PDS publishes its public communities at
 * /.well-known/openfederation-communities.json, and
 * net.openfederation.community.discover merges them with the same document
 * fetched from every peer in FEDERATION_PEERS. Peers here are small local
 * HTTP servers: one well-behaved, one that never answers, one that sends
 * garbage, one that sends too much, and the well-behaved one also tries to
 * pass off a private community and our own private community as public.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { api, xrpcGet, xrpcAuthPost, createTestUser, isPLCAvailable, uniqueHandle } from './helpers.js';
import { config } from '../../src/config.js';
import { _clearDiscoveryCache } from '../../src/federation/community-discovery.js';

const WELL_KNOWN = '/.well-known/openfederation-communities.json';
const SECRET_NAME = 'Hidden Discovery Circle';
const PUBLIC_NAME = 'Open Discovery Guild';

type Peer = { url: string; hits: () => number; close: () => Promise<void> };

async function startPeer(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<Peer> {
  let hits = 0;
  const sockets = new Set<import('node:net').Socket>();
  const server = http.createServer((req, res) => {
    if (req.url === WELL_KNOWN) hits++;
    handler(req, res);
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    hits: () => hits,
    close: () => new Promise<void>((resolve) => {
      for (const s of sockets) s.destroy();
      server.close(() => resolve());
    }),
  };
}

function sendJson(res: http.ServerResponse, body: unknown) {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

describe('community discovery across servers (#41)', () => {
  let plcAvailable = false;
  let publicDid: string;
  let privateDid: string;
  let goodPeer: Peer;
  let slowPeer: Peer;
  let garbagePeer: Peer;
  let hugePeer: Peer;
  const savedPeers = config.federation.peerUrls;
  const savedEnabled = config.federation.enabled;
  const savedTimeout = config.federation.peerTimeoutMs;
  const savedTtl = config.federation.cacheTtlMs;

  beforeAll(async () => {
    plcAvailable = await isPLCAvailable();
    if (!plcAvailable) return;

    const owner = await createTestUser(uniqueHandle('disc-owner'));
    const pub = await xrpcAuthPost('net.openfederation.community.create', owner.accessJwt, {
      handle: uniqueHandle('disc-pub'),
      didMethod: 'plc',
      visibility: 'public',
      joinPolicy: 'open',
      displayName: PUBLIC_NAME,
      description: 'Anyone may find us',
    });
    expect(pub.status).toBe(201);
    publicDid = pub.body.did;

    const priv = await xrpcAuthPost('net.openfederation.community.create', owner.accessJwt, {
      handle: uniqueHandle('disc-priv'),
      didMethod: 'plc',
      visibility: 'private',
      joinPolicy: 'approval',
      displayName: SECRET_NAME,
      description: 'Nobody outside may read this',
    });
    expect(priv.status).toBe(201);
    privateDid = priv.body.did;

    goodPeer = await startPeer((req, res) => {
      if (req.url !== WELL_KNOWN) { res.writeHead(404); res.end(); return; }
      sendJson(res, {
        version: 1,
        pds: { url: 'https://claims-to-be-elsewhere.example' },
        communities: [
          { did: 'did:web:chess.peer.test', handle: 'chess.peer.test', displayName: 'Peer Chess Club', description: 'Chess on another server', memberCount: 12 },
          { did: 'did:web:knitting.peer.test', handle: 'knitting.peer.test', displayName: 'Peer Knitting', description: 'Yarn', memberCount: 3 },
          // A peer saying outright that this one is private: never shown.
          { did: 'did:web:secret.peer.test', handle: 'secret.peer.test', displayName: 'Peer Secret', description: '', memberCount: 1, visibility: 'private' },
          // A peer claiming OUR private community, with its real name: never shown.
          { did: privateDid, handle: 'stolen.peer.test', displayName: SECRET_NAME, description: 'leaked', memberCount: 99 },
          // A peer re-listing our public community: local copy wins.
          { did: publicDid, handle: 'dup.peer.test', displayName: 'Impostor Name', description: '', memberCount: 1000 },
          // Malformed entries are dropped one by one.
          { did: 'javascript:alert(1)', handle: 'x.peer.test', displayName: 'Bad', memberCount: 1 },
          { handle: 'nodid.peer.test' },
        ],
      });
    });
    // Accepts the connection and never answers.
    slowPeer = await startPeer(() => { /* hang */ });
    garbagePeer = await startPeer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html>not json</html>');
    });
    hugePeer = await startPeer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ version: 1, communities: [], padding: 'x'.repeat(2 * 1024 * 1024) }));
    });

    config.federation.enabled = true;
    config.federation.peerUrls = [goodPeer.url, slowPeer.url, garbagePeer.url, hugePeer.url];
    config.federation.peerTimeoutMs = 500;
    config.federation.cacheTtlMs = 60_000;
    _clearDiscoveryCache();
  });

  afterAll(async () => {
    config.federation.peerUrls = savedPeers;
    config.federation.enabled = savedEnabled;
    config.federation.peerTimeoutMs = savedTimeout;
    config.federation.cacheTtlMs = savedTtl;
    _clearDiscoveryCache();
    await Promise.all([goodPeer, slowPeer, garbagePeer, hugePeer].filter(Boolean).map((p) => p.close()));
  });

  describe('well-known document', () => {
    it('lists the public community with the documented fields', async () => {
      if (!plcAvailable) return;
      const res = await api.get(WELL_KNOWN);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/application\/json/);
      expect(res.body.version).toBe(1);
      expect(res.body.pds.url).toBe(config.pds.serviceUrl);
      const mine = res.body.communities.find((c: any) => c.did === publicDid);
      expect(mine).toMatchObject({
        did: publicDid,
        displayName: PUBLIC_NAME,
        description: 'Anyone may find us',
        memberCount: 1,
        pdsUrl: config.pds.serviceUrl,
      });
      expect(typeof mine.handle).toBe('string');
    });

    it('never contains a private community', async () => {
      if (!plcAvailable) return;
      const res = await api.get(WELL_KNOWN);
      expect(res.status).toBe(200);
      expect(res.text).not.toContain(privateDid);
      expect(res.text).not.toContain(SECRET_NAME);
    });

    it('lists only what is local, never what peers sent', async () => {
      if (!plcAvailable) return;
      await xrpcGet('net.openfederation.community.discover', {});
      const res = await api.get(WELL_KNOWN);
      expect(res.text).not.toContain('did:web:chess.peer.test');
    });
  });

  describe('net.openfederation.community.discover', () => {
    it('merges local and peer communities and reports the peers that failed', async () => {
      if (!plcAvailable) return;
      _clearDiscoveryCache();
      const started = Date.now();
      const res = await xrpcGet('net.openfederation.community.discover', { limit: '100' });
      expect(res.status).toBe(200);
      // The slow peer is cut off by the timeout, not waited on.
      expect(Date.now() - started).toBeLessThan(5000);

      const byDid = new Map(res.body.communities.map((c: any) => [c.did, c]));
      expect(byDid.get(publicDid)).toMatchObject({
        displayName: PUBLIC_NAME, pdsUrl: config.pds.serviceUrl, source: 'local', memberCount: 1,
      });
      expect(byDid.get('did:web:chess.peer.test')).toEqual({
        did: 'did:web:chess.peer.test',
        handle: 'chess.peer.test',
        displayName: 'Peer Chess Club',
        description: 'Chess on another server',
        memberCount: 12,
        // Stamped with the server we fetched from, not what the peer claimed.
        pdsUrl: goodPeer.url,
        source: 'peer',
      });
      expect(byDid.has('did:web:knitting.peer.test')).toBe(true);

      // Untrusted peer data: no private, no claim over a community hosted here, no malformed.
      expect(byDid.has('did:web:secret.peer.test')).toBe(false);
      expect(byDid.has(privateDid)).toBe(false);
      expect(JSON.stringify(res.body)).not.toContain(SECRET_NAME);
      expect(JSON.stringify(res.body)).not.toContain('Impostor Name');
      expect(byDid.has('javascript:alert(1)')).toBe(false);

      // Deduplicated by DID.
      const dids = res.body.communities.map((c: any) => c.did);
      expect(new Set(dids).size).toBe(dids.length);

      const status = new Map(res.body.peers.map((p: any) => [p.url, p]));
      expect(status.get(goodPeer.url)).toMatchObject({ status: 'ok', communityCount: 2 });
      expect(status.get(slowPeer.url)).toMatchObject({ status: 'failed', error: 'Timeout' });
      expect(status.get(garbagePeer.url)).toMatchObject({ status: 'failed', error: 'InvalidResponse' });
      expect(status.get(hugePeer.url)).toMatchObject({ status: 'failed', error: 'ResponseTooLarge' });
    });

    it('caches peer documents for the TTL', async () => {
      if (!plcAvailable) return;
      _clearDiscoveryCache();
      await xrpcGet('net.openfederation.community.discover', {});
      const after = goodPeer.hits();
      await xrpcGet('net.openfederation.community.discover', {});
      await xrpcGet('net.openfederation.community.discover', {});
      expect(goodPeer.hits()).toBe(after);
    });

    it('pages with limit and cursor without repeats', async () => {
      if (!plcAvailable) return;
      const all = await xrpcGet('net.openfederation.community.discover', { limit: '100' });
      const total = all.body.communities.length;
      const seen: string[] = [];
      let cursor: string | undefined;
      for (let i = 0; i < 200; i++) {
        const params: Record<string, string> = { limit: '2' };
        if (cursor) params.cursor = cursor;
        const page = await xrpcGet('net.openfederation.community.discover', params);
        expect(page.status).toBe(200);
        expect(page.body.communities.length).toBeLessThanOrEqual(2);
        seen.push(...page.body.communities.map((c: any) => c.did));
        cursor = page.body.cursor;
        if (!cursor) break;
      }
      expect(seen.length).toBe(total);
      expect(new Set(seen).size).toBe(total);
    });

    it('filters by text across name, handle and description', async () => {
      if (!plcAvailable) return;
      const res = await xrpcGet('net.openfederation.community.discover', { q: 'chess' });
      expect(res.status).toBe(200);
      expect(res.body.communities.map((c: any) => c.did)).toEqual(['did:web:chess.peer.test']);
    });

    it('refuses a malformed cursor or limit', async () => {
      if (!plcAvailable) return;
      expect((await xrpcGet('net.openfederation.community.discover', { cursor: 'abc' })).status).toBe(400);
      expect((await xrpcGet('net.openfederation.community.discover', { limit: '0' })).status).toBe(400);
    });

    it('answers with local communities only when no peers are configured', async () => {
      if (!plcAvailable) return;
      config.federation.peerUrls = [];
      _clearDiscoveryCache();
      try {
        const res = await xrpcGet('net.openfederation.community.discover', { limit: '100' });
        expect(res.status).toBe(200);
        expect(res.body.peers).toEqual([]);
        expect(res.body.communities.every((c: any) => c.source === 'local')).toBe(true);
        expect(res.body.communities.some((c: any) => c.did === publicDid)).toBe(true);
        expect(res.body.communities.some((c: any) => c.did === privateDid)).toBe(false);
      } finally {
        config.federation.peerUrls = [goodPeer.url, slowPeer.url, garbagePeer.url, hugePeer.url];
        _clearDiscoveryCache();
      }
    });

    it('skips peers when FEDERATION_PEERS_ENABLED is false', async () => {
      if (!plcAvailable) return;
      config.federation.enabled = false;
      _clearDiscoveryCache();
      const before = goodPeer.hits();
      try {
        const res = await xrpcGet('net.openfederation.community.discover', {});
        expect(res.status).toBe(200);
        expect(res.body.peers).toEqual([]);
        expect(goodPeer.hits()).toBe(before);
      } finally {
        config.federation.enabled = true;
        _clearDiscoveryCache();
      }
    });
  });
});
