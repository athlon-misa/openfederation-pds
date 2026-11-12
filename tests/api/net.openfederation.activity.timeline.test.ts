/**
 * Per-user timelines across community memberships (#42): home-PDS fan-out.
 *
 * getUserTimeline merges activity from communities hosted here (database) and
 * from configured peer PDSes (an injected client stands in for the network),
 * newest first, with a cursor that is stable when timestamps tie.
 * listCommunityActivity is the per-PDS endpoint a home PDS calls; it enforces
 * community privacy itself.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { Secp256k1Keypair } from '@atproto/crypto';
import {
  api, xrpcAuthGet, xrpcAuthPost, xrpcGet, createTestUser, isPLCAvailable, uniqueHandle,
} from './helpers.js';
import { query } from '../../src/db/client.js';
import { config } from '../../src/config.js';
import { decryptKeyBytes } from '../../src/auth/encryption.js';
import {
  signServiceAuthJwt, getServiceDid, _clearReplayCache, _resetServiceAuthRateLimiter,
} from '../../src/auth/service-auth.js';
import { _clearActivityFeedCache, compareActivity, type ActivityEntry } from '../../src/activity/feed.js';
import { _clearRemoteActivityCache, _setRemoteTimeoutMs } from '../../src/activity/timeline.js';
import { _setRemoteActivityClient, type RemoteActivityClient } from '../../src/activity/remote.js';

type User = { accessJwt: string; did: string; handle: string };
const TIMELINE = 'net.openfederation.activity.getUserTimeline';
const LIST = 'net.openfederation.activity.listCommunityActivity';

function listActivity(token: string, communities: string[], extra: Record<string, string> = {}) {
  const qs = new URLSearchParams(extra);
  for (const c of communities) qs.append('community', c);
  return api.get(`/xrpc/${LIST}?${qs.toString()}`).set('Authorization', `Bearer ${token}`);
}

async function allPages(token: string, limit: number): Promise<ActivityEntry[]> {
  const out: ActivityEntry[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 200; i++) {
    const res = await xrpcAuthGet(TIMELINE, token, { limit: String(limit), ...(cursor ? { cursor } : {}) });
    expect(res.status).toBe(200);
    out.push(...res.body.entries);
    cursor = res.body.cursor;
    if (!cursor) return out;
  }
  throw new Error('paging did not end');
}

function resetCaches() {
  _clearActivityFeedCache();
  _clearRemoteActivityCache();
}

describe('activity timelines', () => {
  let plc = false;
  let owner: User, viewer: User, outsider: User;
  let pubA: string, pubB: string, privC: string, privD: string, gated: string;
  const savedPeers = config.federation.peerUrls;

  const createCommunity = async (who: User, visibility: 'public' | 'private', joinPolicy: 'open' | 'approval' = 'open') => {
    const res = await xrpcAuthPost('net.openfederation.community.create', who.accessJwt, {
      handle: uniqueHandle('act'), didMethod: 'plc', visibility, joinPolicy,
    });
    expect(res.status).toBe(201);
    return res.body.did as string;
  };
  const join = async (who: User, did: string) => {
    const res = await xrpcAuthPost('net.openfederation.community.join', who.accessJwt, { did });
    expect(res.status).toBe(200);
    return res.body.status as string;
  };
  const thread = async (who: User, community: string, title: string) => {
    const res = await xrpcAuthPost('net.openfederation.forum.createThread', who.accessJwt, { community, title });
    expect(res.status).toBe(200);
    return res.body as { uri: string; cid: string };
  };
  const event = async (who: User, community: string, name: string) => {
    const res = await xrpcAuthPost('net.openfederation.calendar.createEvent', who.accessJwt, {
      community, name, startsAt: '2027-01-01T18:00:00.000Z',
    });
    expect(res.status).toBe(200);
    return res.body as { uri: string };
  };

  beforeAll(async () => {
    plc = await isPLCAvailable();
    if (!plc) return;
    owner = await createTestUser(uniqueHandle('act-owner'));
    viewer = await createTestUser(uniqueHandle('act-viewer'));
    outsider = await createTestUser(uniqueHandle('act-out'));

    pubA = await createCommunity(owner, 'public');
    pubB = await createCommunity(owner, 'public');
    privC = await createCommunity(owner, 'private');
    privD = await createCommunity(owner, 'private');
    // Owned by the viewer, approval-only: the outsider's request is activity
    // only the owner sees.
    gated = await createCommunity(viewer, 'public', 'approval');

    for (const c of [pubA, pubB, privC]) await join(viewer, c);
    await join(outsider, pubA);
    expect(await join(outsider, gated)).toBe('pending');

    await thread(owner, pubA, 'A first');
    await event(owner, pubB, 'B meetup');
    await thread(viewer, privC, 'C members only');
    await thread(owner, pubA, 'A second');
    await thread(owner, privD, 'D secret');
    await event(owner, privC, 'C private event');
  }, 120_000);

  afterEach(() => {
    _setRemoteActivityClient(null);
    _setRemoteTimeoutMs(null);
    config.federation.peerUrls = savedPeers;
    resetCaches();
  });

  afterAll(() => {
    config.federation.peerUrls = savedPeers;
  });

  it('requires authentication', async () => {
    const res = await xrpcGet(TIMELINE);
    expect(res.status).toBe(401);
  });

  it('merges every membership newest first, and pages through all of it with a cursor', async () => {
    if (!plc) return;
    const res = await xrpcAuthGet(TIMELINE, viewer.accessJwt, { limit: '100' });
    expect(res.status).toBe(200);
    const full: ActivityEntry[] = res.body.entries;
    expect(res.body.cursor).toBeUndefined();
    expect(res.body.unreachable).toEqual([]);
    expect(res.body.unreachablePeers).toEqual([]);

    // Newest first, strictly, by (createdAt, id).
    for (let i = 1; i < full.length; i++) expect(compareActivity(full[i - 1], full[i])).toBeLessThan(0);
    const communities = new Set(full.map((e) => e.community));
    for (const c of [pubA, pubB, privC, gated]) expect(communities.has(c)).toBe(true);
    expect(communities.has(privD)).toBe(false);

    const kinds = new Set(full.map((e) => e.kind));
    for (const k of ['member.joined', 'forum.thread.created', 'event.created', 'joinRequest.created']) {
      expect(kinds.has(k)).toBe(true);
    }
    const titles = full.filter((e) => e.kind === 'forum.thread.created').map((e) => e.summary?.title);
    expect(titles.indexOf('A second')).toBeLessThan(titles.indexOf('A first'));

    // Pages of 2 add up to exactly the same list, in the same order.
    const paged = await allPages(viewer.accessJwt, 2);
    expect(paged.map((e) => e.id)).toEqual(full.map((e) => e.id));
  });

  it('keeps the cursor stable when entries share a timestamp', async () => {
    if (!plc) return;
    const c = await createCommunity(owner, 'public');
    const tieUser = await createTestUser(uniqueHandle('act-tie'));
    await join(tieUser, c);
    for (const t of ['tie 1', 'tie 2', 'tie 3', 'tie 4']) await thread(owner, c, t);
    // Same instant for every thread, member row and record in the community.
    const instant = '2030-05-05T05:05:05.123456Z';
    await query('UPDATE forum_threads SET created_at = $2 WHERE community_did = $1', [c, instant]);
    await query('UPDATE members_unique SET created_at = $2 WHERE community_did = $1', [c, instant]);
    await query('UPDATE records_index SET created_at = $2 WHERE community_did = $1', [c, instant]);
    resetCaches();

    const paged = await allPages(tieUser.accessJwt, 1);
    const tied = paged.filter((e) => e.createdAt === instant);
    expect(tied.length).toBe(6); // 4 threads + owner and tieUser joining
    expect(new Set(paged.map((e) => e.id)).size).toBe(paged.length);
    const full = (await xrpcAuthGet(TIMELINE, tieUser.accessJwt, { limit: '100' })).body.entries as ActivityEntry[];
    expect(paged.map((e) => e.id)).toEqual(full.map((e) => e.id));
  });

  it('rejects a cursor it did not hand out', async () => {
    if (!plc) return;
    const res = await xrpcAuthGet(TIMELINE, viewer.accessJwt, { cursor: 'not-a-cursor!' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('InvalidRequest');
  });

  describe('privacy (listCommunityActivity)', () => {
    it('lists a private community only to its members, answering for it as for a missing DID', async () => {
      if (!plc) return;
      const missing = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';
      const asOutsider = await listActivity(outsider.accessJwt, [pubA, privC, missing]);
      expect(asOutsider.status).toBe(200);
      expect(asOutsider.body.unavailable.sort()).toEqual([privC, missing].sort());
      expect(asOutsider.body.entries.some((e: ActivityEntry) => e.community === privC)).toBe(false);
      expect(asOutsider.body.entries.some((e: ActivityEntry) => e.community === pubA)).toBe(true);

      const asMember = await listActivity(viewer.accessJwt, [privC, privD]);
      expect(asMember.status).toBe(200);
      expect(asMember.body.unavailable).toEqual([privD]);
      const titles = asMember.body.entries.map((e: ActivityEntry) => e.summary?.title ?? e.summary?.name);
      expect(titles).toContain('C members only');
      expect(titles).toContain('C private event');
      expect(JSON.stringify(asMember.body)).not.toContain('D secret');
    });

    it('never shows a private community the caller does not belong to on their timeline', async () => {
      if (!plc) return;
      const res = await xrpcAuthGet(TIMELINE, outsider.accessJwt, { limit: '100' });
      expect(res.status).toBe(200);
      const communities = new Set(res.body.entries.map((e: ActivityEntry) => e.community));
      expect(communities.has(privC)).toBe(false);
      expect(communities.has(privD)).toBe(false);
      expect(JSON.stringify(res.body)).not.toMatch(/members only|secret|private event/);
    });

    it('shows join requests to the owner only', async () => {
      if (!plc) return;
      const asOwner = await listActivity(viewer.accessJwt, [gated]);
      const requests = asOwner.body.entries.filter((e: ActivityEntry) => e.kind === 'joinRequest.created');
      expect(requests).toHaveLength(1);
      expect(requests[0].actor).toBe(outsider.did);
      expect(requests[0].uri).toBeUndefined();

      const asOther = await listActivity(owner.accessJwt, [gated]);
      expect(asOther.status).toBe(200);
      expect(asOther.body.entries.some((e: ActivityEntry) => e.kind === 'joinRequest.created')).toBe(false);
    });

    it('accepts a service-auth token for the method, and getUserTimeline refuses one', async () => {
      if (!plc) return;
      _clearReplayCache();
      _resetServiceAuthRateLimiter();
      const keyRes = await query<{ signing_key_bytes: Buffer }>(
        'SELECT signing_key_bytes FROM user_signing_keys WHERE user_did = $1', [viewer.did]);
      const keypair = await Secp256k1Keypair.import(
        await decryptKeyBytes(keyRes.rows[0].signing_key_bytes, 'identity.signing-key'));
      const token = (lxm: string) => signServiceAuthJwt({
        keypair, iss: viewer.did, aud: getServiceDid(), lxm, exp: Math.floor(Date.now() / 1000) + 60,
      });

      const listed = await listActivity(await token(LIST), [privC]);
      expect(listed.status).toBe(200);
      expect(listed.body.unavailable).toEqual([]);
      expect(listed.body.entries.length).toBeGreaterThan(0);

      const refused = await xrpcAuthGet(TIMELINE, await token(TIMELINE));
      expect(refused.status).toBe(403);
    });

    it('caps the number of communities per call', async () => {
      if (!plc) return;
      const many = Array.from({ length: 26 }, (_, i) => `did:plc:${String(i).padStart(24, 'a')}`);
      const res = await listActivity(viewer.accessJwt, many);
      expect(res.status).toBe(400);
    });
  });

  describe('remote communities', () => {
    const remoteDid = 'did:plc:remotecommunity000000001';
    const slowDid = 'did:plc:slowcommunity00000000001';
    const remoteEntry = (n: number, community = remoteDid): ActivityEntry => ({
      id: `at://${community}/net.openfederation.forum.thread/r${n}`,
      kind: 'forum.thread.created',
      community,
      actor: 'did:plc:someremoteauthor00000001',
      uri: `at://${community}/net.openfederation.forum.thread/r${n}`,
      createdAt: `2031-01-0${n}T00:00:00.000Z`,
      summary: { title: `remote ${n}` },
    });

    function fakeClient(opts: { slowMs?: number; failDiscovery?: string } = {}): RemoteActivityClient & { calls: string[] } {
      const calls: string[] = [];
      return {
        calls,
        async listMemberships(peerUrl, viewerDid) {
          calls.push(`members ${peerUrl} ${viewerDid}`);
          if (peerUrl === opts.failDiscovery) throw new Error('down');
          return peerUrl === 'https://peer.example' ? [remoteDid] : [slowDid];
        },
        async listActivity(peerUrl, _viewer, communities, limit, cursor, signal) {
          calls.push(`activity ${peerUrl} ${communities.join(',')} ${limit} ${cursor ?? ''}`);
          if (peerUrl === 'https://slow.example') {
            await new Promise((resolve, reject) => {
              const t = setTimeout(resolve, opts.slowMs ?? 2_000);
              signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); });
            });
            return { entries: [remoteEntry(9, slowDid)], unavailable: [] };
          }
          return {
            // The second entry names a community the peer was not asked about: dropped.
            entries: [remoteEntry(2), remoteEntry(1), remoteEntry(3, 'did:plc:notaskedabout000000000001')],
            unavailable: [],
          };
        },
      };
    }

    it('merges a peer\'s activity in time order with what is hosted here', async () => {
      if (!plc) return;
      const client = fakeClient();
      _setRemoteActivityClient(client);
      config.federation.peerUrls = ['https://peer.example'];

      const res = await xrpcAuthGet(TIMELINE, viewer.accessJwt, { limit: '100' });
      expect(res.status).toBe(200);
      const entries: ActivityEntry[] = res.body.entries;
      // 2031 is in the future of everything local: the remote entries lead.
      expect(entries.slice(0, 2).map((e) => e.summary?.title)).toEqual(['remote 2', 'remote 1']);
      expect(entries.find((e) => e.community === 'did:plc:notaskedabout000000000001')).toBeUndefined();
      expect(entries.some((e) => e.community === pubA)).toBe(true);
      expect(entries[0].createdAt).toBe('2031-01-02T00:00:00.000000Z');
      expect(res.body.unreachable).toEqual([]);
      expect(client.calls.some((c) => c.startsWith(`members https://peer.example ${viewer.did}`))).toBe(true);

      // A second call within the cache window asks the peer nothing.
      const before = client.calls.length;
      await xrpcAuthGet(TIMELINE, viewer.accessJwt, { limit: '100' });
      expect(client.calls.length).toBe(before);
    });

    it('answers with partial results when a peer is too slow, and names what is missing', async () => {
      if (!plc) return;
      _setRemoteActivityClient(fakeClient({ slowMs: 3_000 }));
      _setRemoteTimeoutMs(200);
      config.federation.peerUrls = ['https://peer.example', 'https://slow.example'];

      const started = Date.now();
      const res = await xrpcAuthGet(TIMELINE, viewer.accessJwt, { limit: '100' });
      const elapsed = Date.now() - started;
      expect(res.status).toBe(200);
      expect(elapsed).toBeLessThan(1_500);
      expect(res.body.unreachable).toEqual([slowDid]);
      expect(res.body.unreachablePeers).toEqual([]);
      const communities = new Set(res.body.entries.map((e: ActivityEntry) => e.community));
      expect(communities.has(remoteDid)).toBe(true);
      expect(communities.has(pubA)).toBe(true);
      expect(communities.has(slowDid)).toBe(false);
    });

    it('names a peer it could not ask about memberships', async () => {
      if (!plc) return;
      _setRemoteActivityClient(fakeClient({ failDiscovery: 'https://slow.example' }));
      config.federation.peerUrls = ['https://peer.example', 'https://slow.example'];
      const res = await xrpcAuthGet(TIMELINE, viewer.accessJwt, { limit: '100' });
      expect(res.status).toBe(200);
      expect(res.body.unreachablePeers).toEqual(['https://slow.example']);
      expect(res.body.entries.some((e: ActivityEntry) => e.community === remoteDid)).toBe(true);
    });

    it('passes the cursor to the peer so paging covers remote activity too', async () => {
      if (!plc) return;
      const client = fakeClient();
      _setRemoteActivityClient(client);
      config.federation.peerUrls = ['https://peer.example'];
      const first = await xrpcAuthGet(TIMELINE, viewer.accessJwt, { limit: '1' });
      expect(first.body.entries[0].summary.title).toBe('remote 2');
      const second = await xrpcAuthGet(TIMELINE, viewer.accessJwt, { limit: '1', cursor: first.body.cursor });
      expect(client.calls.some((c) => c.startsWith('activity https://peer.example') && c.endsWith(first.body.cursor))).toBe(true);
      // The fake ignores the cursor; the home PDS still drops what is not after it.
      expect(second.body.entries[0].summary.title).toBe('remote 1');
    });
  });

  it('p95 under 500 ms for a user with 20 memberships (uncached)', async () => {
    if (!plc) return;
    const member = await createTestUser(uniqueHandle('act-perf'));
    const communities: string[] = [];
    for (let i = 0; i < 20; i++) {
      const c = await createCommunity(owner, i % 4 === 0 ? 'private' : 'public');
      await join(member, c);
      await thread(owner, c, `perf thread ${i}`);
      await event(owner, c, `perf event ${i}`);
      communities.push(c);
    }

    const timings: number[] = [];
    for (let i = 0; i < 40; i++) {
      resetCaches();
      const started = performance.now();
      const res = await xrpcAuthGet(TIMELINE, member.accessJwt, { limit: '30' });
      timings.push(performance.now() - started);
      expect(res.status).toBe(200);
      expect(res.body.entries).toHaveLength(30);
    }
    timings.sort((a, b) => a - b);
    const p50 = timings[Math.floor(timings.length * 0.5)];
    const p95 = timings[Math.ceil(timings.length * 0.95) - 1];
    console.log(`[activity] getUserTimeline, 20 memberships, uncached: p50 ${p50.toFixed(1)} ms, p95 ${p95.toFixed(1)} ms, max ${timings[timings.length - 1].toFixed(1)} ms`);
    expect(p95).toBeLessThan(500);

    // The same user with 10 more memberships on each of three peers that take
    // 150 ms to answer: peers are asked in parallel, so it costs one wait.
    const peers = ['https://p1.example', 'https://p2.example', 'https://p3.example'];
    const remoteOf = (peer: string) => Array.from({ length: 10 }, (_, i) =>
      `did:plc:${peer.slice(8, 10)}${String(i).padStart(22, 'x')}`);
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    _setRemoteActivityClient({
      async listMemberships(peer) { await wait(150); return remoteOf(peer); },
      async listActivity(peer, _v, group) {
        await wait(150);
        return {
          entries: group.map((c, i) => ({
            id: `at://${c}/net.openfederation.forum.thread/x${i}`, kind: 'forum.thread.created', community: c,
            createdAt: new Date(Date.now() - i * 1000).toISOString(), summary: { title: `${peer} ${i}` },
          })),
          unavailable: [],
        };
      },
    });
    config.federation.peerUrls = peers;
    // Room for a stalled event loop on a loaded machine: this part is about
    // the calls running in parallel, not about the deadline.
    _setRemoteTimeoutMs(1_000);
    const withPeers: number[] = [];
    for (let i = 0; i < 40; i++) {
      resetCaches();
      const started = performance.now();
      const res = await xrpcAuthGet(TIMELINE, member.accessJwt, { limit: '30' });
      withPeers.push(performance.now() - started);
      expect(res.body.unreachable).toEqual([]);
      expect(res.body.entries.some((e: ActivityEntry) => e.community.startsWith('did:plc:p2'))).toBe(true);
    }
    withPeers.sort((a, b) => a - b);
    const p50Peers = withPeers[Math.floor(withPeers.length * 0.5)];
    const p95Peers = withPeers[Math.ceil(withPeers.length * 0.95) - 1];
    console.log(`[activity] getUserTimeline, 20 local + 3 peers x 10 (150 ms per call), uncached: p50 ${p50Peers.toFixed(1)} ms, p95 ${p95Peers.toFixed(1)} ms`);
    // Discovery then activity: two sequential 150 ms waits (~300 ms), not six
    // (~900 ms). The median, because a single stall on a busy machine moves p95.
    expect(p50Peers).toBeLessThan(450);
  }, 180_000);
});
