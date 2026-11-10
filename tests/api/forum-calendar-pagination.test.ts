/**
 * Forum and calendar lists page through every item exactly once, including
 * items that share a timestamp, and no list is unbounded.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { xrpcAuthPost, xrpcAuthGet, createTestUser, isPLCAvailable, uniqueHandle } from './helpers.js';
import { query } from '../../src/db/client.js';

type User = { accessJwt: string; did: string; handle: string };

async function pageAll(
  nsid: string, token: string, base: Record<string, string>, cursorParam: string, pick: (body: any) => string[],
): Promise<string[]> {
  const seen: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const res = await xrpcAuthGet(nsid, token, cursor ? { ...base, [cursorParam]: cursor } : base);
    expect(res.status, `${nsid} page ${page}`).toBe(200);
    seen.push(...pick(res.body));
    cursor = res.body.cursor;
    if (!cursor) break;
  }
  return seen;
}

describe('forum and calendar pagination', () => {
  let plc: boolean;
  let owner: User;
  let community: string;

  beforeAll(async () => {
    plc = await isPLCAvailable();
    if (!plc) return;
    owner = await createTestUser(uniqueHandle('fcp-owner'));
    const created = await xrpcAuthPost('net.openfederation.community.create', owner.accessJwt, {
      handle: uniqueHandle('fcp'), didMethod: 'plc', visibility: 'public', joinPolicy: 'open',
    });
    community = created.body.did;
  });

  it('listThreads returns every thread once, even when several share a timestamp', async () => {
    if (!plc) return;
    const made: string[] = [];
    for (let i = 0; i < 5; i++) {
      const t = await xrpcAuthPost('net.openfederation.forum.createThread', owner.accessJwt, { community, title: `T${i}` });
      expect(t.status).toBe(200);
      made.push(t.body.uri);
    }
    // Three of them were active at exactly the same instant.
    await query(`UPDATE forum_threads SET last_activity = '2026-01-01T00:00:00Z' WHERE uri = ANY($1)`, [made.slice(0, 3)]);

    const seen = await pageAll('net.openfederation.forum.listThreads', owner.accessJwt,
      { community, limit: '2' }, 'before', (b) => b.threads.map((t: any) => t.uri));
    expect([...seen].sort()).toEqual([...made].sort());
  });

  it('getThread returns every post once, even when several share a timestamp', async () => {
    if (!plc) return;
    const thread = await xrpcAuthPost('net.openfederation.forum.createThread', owner.accessJwt, { community, title: 'posts' });
    const made: string[] = [];
    for (let i = 0; i < 5; i++) {
      const p = await xrpcAuthPost('net.openfederation.forum.createPost', owner.accessJwt, {
        community, root: { uri: thread.body.uri, cid: thread.body.cid }, text: `reply ${i}`,
      });
      expect(p.status).toBe(200);
      made.push(p.body.uri);
    }
    await query(`UPDATE forum_posts SET created_at = '2026-01-01T00:00:00Z' WHERE uri = ANY($1)`, [made.slice(1, 4)]);

    const seen = await pageAll('net.openfederation.forum.getThread', owner.accessJwt,
      { uri: thread.body.uri, limit: '2' }, 'after', (b) => b.posts.map((p: any) => p.uri));
    for (const uri of made) expect(seen.filter((s) => s === uri), uri).toHaveLength(1);
  });

  it('listEvents pages instead of silently stopping', async () => {
    if (!plc) return;
    const made: string[] = [];
    for (let i = 0; i < 5; i++) {
      const e = await xrpcAuthPost('net.openfederation.calendar.createEvent', owner.accessJwt, { community, name: `E${i}` });
      expect(e.status).toBe(200);
      made.push(e.body.uri);
    }
    const seen = await pageAll('net.openfederation.calendar.listEvents', owner.accessJwt,
      { community, limit: '2' }, 'cursor', (b) => b.events.map((e: any) => e.uri));
    expect([...seen].sort()).toEqual([...made].sort());
  });

  it('listRsvps is bounded, with counts that still cover everyone', async () => {
    if (!plc) return;
    const e = await xrpcAuthPost('net.openfederation.calendar.createEvent', owner.accessJwt, { community, name: 'Big' });
    for (let i = 0; i < 5; i++) {
      await query(
        `INSERT INTO event_rsvps (uri, event_uri, attendee_did, status, created_at)
         VALUES ($1, $2, $3, 'going', CURRENT_TIMESTAMP)`,
        [`at://did:plc:att${i}${Date.now()}/x/y`, e.body.uri, `did:plc:att${i}${Date.now()}`]);
    }
    const first = await xrpcAuthGet('net.openfederation.calendar.listRsvps', owner.accessJwt, { event: e.body.uri, limit: '2' });
    expect(first.status).toBe(200);
    expect(first.body.rsvps).toHaveLength(2);
    expect(first.body.counts.going).toBe(5);
    expect(first.body.cursor).toBeTruthy();

    const seen = await pageAll('net.openfederation.calendar.listRsvps', owner.accessJwt,
      { event: e.body.uri, limit: '2' }, 'cursor', (b) => b.rsvps.map((r: any) => r.attendeeDid));
    expect(new Set(seen).size).toBe(5);
    expect(seen).toHaveLength(5);
  });
});
