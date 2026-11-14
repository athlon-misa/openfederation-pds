/**
 * getUserTimeline reads memberships from the viewer's own repo first (#385).
 *
 * A membership record at home names a community on any PDS, configured peer
 * or not; the timeline resolves the community's PDS from its DID and asks it.
 * The community side stays the authority: a home claim the community's PDS
 * does not confirm (community.listMine) is a bookmark, and its activity is
 * not shown. Configured peers are still asked, as the fallback for
 * memberships with no home record (private communities, older joins).
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { xrpcAuthGet, createTestUser, isPLCAvailable, uniqueHandle } from './helpers.js';
import { runtimeSettings } from '../../src/settings/runtime-settings.js';
import { _clearActivityFeedCache, type ActivityEntry } from '../../src/activity/feed.js';
import { _clearRemoteActivityCache, _setRemoteTimeoutMs } from '../../src/activity/timeline.js';
import { _setRemoteActivityClient, type RemoteActivityClient } from '../../src/activity/remote.js';
import { RepoEngine } from '../../src/repo/repo-engine.js';
import { getKeypairForDid } from '../../src/repo/keypair-utils.js';
import { MEMBERSHIP_COLLECTION, membershipRecord } from '../../src/community/membership/home-record.js';

const TIMELINE = 'net.openfederation.activity.getUserTimeline';
const farDid = 'did:plc:farcommunityxxxxxxxxxxxxx';
const bookmarkDid = 'did:plc:bookmarkonlyxxxxxxxxxxxxx';
const goneDid = 'did:plc:doesnotresolvexxxxxxxxxxx';
const peerDid = 'did:plc:peercommunityxxxxxxxxxxxx';

const entry = (community: string, n: number): ActivityEntry => ({
  id: `at://${community}/net.openfederation.forum.thread/t${n}`,
  kind: 'forum.thread.created',
  community,
  createdAt: `2032-02-0${n}T00:00:00.000Z`,
  summary: { title: `${community} ${n}` },
});

function fakeClient(opts: { failFar?: boolean } = {}): RemoteActivityClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async resolveCommunityPds(did) {
      calls.push(`resolve ${did}`);
      if (did === farDid || did === bookmarkDid) return 'https://far.example/';
      if (did === peerDid) return 'https://peer.example';
      return null;
    },
    async listMemberships(peerUrl) {
      calls.push(`members ${peerUrl}`);
      if (peerUrl === 'https://far.example' && opts.failFar) throw new Error('down');
      // far.example confirms farDid only; bookmarkDid has no member record there.
      if (peerUrl === 'https://far.example') return [farDid];
      if (peerUrl === 'https://peer.example') return [peerDid];
      return [];
    },
    async listActivity(peerUrl, _viewer, communities) {
      calls.push(`activity ${peerUrl} ${communities.join(',')}`);
      // A peer answering about more than it was asked: only asked-about communities survive.
      return {
        entries: [entry(farDid, 1), entry(bookmarkDid, 2), entry(peerDid, 3)],
        unavailable: [],
      };
    },
  };
}

describe('timeline from home membership records (#385)', () => {
  let plc = false;
  let viewer: { accessJwt: string; did: string };
  const savedPeers = runtimeSettings().federationPeers;

  beforeAll(async () => {
    plc = await isPLCAvailable();
    if (!plc) return;
    viewer = await createTestUser(uniqueHandle('hm-tl'));
    const engine = new RepoEngine(viewer.did);
    const keypair = await getKeypairForDid(viewer.did);
    for (const did of [farDid, bookmarkDid, goneDid]) {
      await engine.putRecord(keypair, MEMBERSHIP_COLLECTION, did, membershipRecord(did));
    }
  }, 60_000);

  afterEach(() => {
    _setRemoteActivityClient(null);
    _setRemoteTimeoutMs(null);
    runtimeSettings().federationPeers = savedPeers;
    _clearActivityFeedCache();
    _clearRemoteActivityCache();
  });

  it('reaches a community on a server that is not a configured peer, and shows only confirmed memberships', async () => {
    if (!plc) return;
    const client = fakeClient();
    _setRemoteActivityClient(client);
    _setRemoteTimeoutMs(2_000);
    runtimeSettings().federationPeers = [];

    const res = await xrpcAuthGet(TIMELINE, viewer.accessJwt, { limit: '50' });
    expect(res.status).toBe(200);
    const communities = new Set((res.body.entries as ActivityEntry[]).map((e) => e.community));
    expect(communities.has(farDid)).toBe(true);
    // A one-sided claim: the community never confirmed it.
    expect(communities.has(bookmarkDid)).toBe(false);
    expect(communities.has(peerDid)).toBe(false);
    expect(client.calls).toContain('members https://far.example');
    expect(client.calls).toContain(`activity https://far.example ${farDid}`);
    expect(res.body.unreachable).toEqual([]);
    expect(res.body.unreachablePeers).toEqual([]);
  });

  it('asks a server once when both a home record and the peer list point at it, and still uses peers as the fallback', async () => {
    if (!plc) return;
    const client = fakeClient();
    _setRemoteActivityClient(client);
    _setRemoteTimeoutMs(2_000);
    runtimeSettings().federationPeers = ['https://far.example', 'https://peer.example'];

    const res = await xrpcAuthGet(TIMELINE, viewer.accessJwt, { limit: '50' });
    expect(res.status).toBe(200);
    const communities = new Set((res.body.entries as ActivityEntry[]).map((e) => e.community));
    expect(communities.has(farDid)).toBe(true);
    // No home record for it, found through the peer.
    expect(communities.has(peerDid)).toBe(true);
    expect(communities.has(bookmarkDid)).toBe(false);
    expect(client.calls.filter((c) => c === 'members https://far.example')).toHaveLength(1);
  });

  it('names the claimed communities unreachable when their server does not answer', async () => {
    if (!plc) return;
    _setRemoteActivityClient(fakeClient({ failFar: true }));
    _setRemoteTimeoutMs(2_000);
    runtimeSettings().federationPeers = [];

    const res = await xrpcAuthGet(TIMELINE, viewer.accessJwt, { limit: '50' });
    expect(res.status).toBe(200);
    expect([...res.body.unreachable].sort()).toEqual([bookmarkDid, farDid].sort());
    expect(res.body.unreachablePeers).toEqual([]);
  });
});
