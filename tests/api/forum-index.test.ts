import { describe, it, expect, beforeAll } from 'vitest';
import {
  indexThread, indexPost, getThread, getThreadPosts, listThreads,
  deindexPost, indexRsvp, listRsvps, setThreadHidden, setPostHidden,
} from '../../src/forum/forum-index.js';
import { query } from '../../src/db/client.js';

const COMM = 'did:plc:idxtestcomm';
const AUTHOR = 'did:plc:idxtestauthor';

describe('forum-index', () => {
  beforeAll(async () => {
    await query('DELETE FROM forum_posts WHERE community_did = $1', [COMM]);
    await query('DELETE FROM forum_threads WHERE community_did = $1', [COMM]);
    await query('DELETE FROM event_rsvps WHERE event_uri LIKE $1', ['at://did:plc:idxtest%']);
  });

  it('indexes a thread and a post, bumping post_count', async () => {
    const threadUri = `at://${AUTHOR}/net.openfederation.forum.thread/t1`;
    await indexThread({ uri: threadUri, cid: 'bafy1', communityDid: COMM, authorDid: AUTHOR, title: 'Hello', tags: [], createdAt: '2026-06-25T00:00:00Z' });

    const postUri = `at://${AUTHOR}/net.openfederation.forum.post/p1`;
    await indexPost({ uri: postUri, cid: 'bafy2', communityDid: COMM, authorDid: AUTHOR, threadRootUri: threadUri, parentUri: null, record: { text: 'hi' }, createdAt: '2026-06-25T00:01:00Z' });

    const thread = await getThread(threadUri);
    expect(thread?.post_count).toBe(1);

    const posts = await getThreadPosts(threadUri, 50, null);
    expect(posts).toHaveLength(1);

    const threads = await listThreads(COMM, 50, null);
    expect(threads.map(t => t.uri)).toContain(threadUri);

    await deindexPost(postUri);
    const after = await getThread(threadUri);
    expect(after?.post_count).toBe(0);
  });

  it('aggregates RSVP counts', async () => {
    const eventUri = 'at://did:plc:idxtestcomm/community.lexicon.calendar.event/e1';
    await indexRsvp({ uri: 'at://did:plc:idxtestA/community.lexicon.calendar.rsvp/r1', eventUri, attendeeDid: 'did:plc:idxtestA', status: 'going', createdAt: '2026-06-25T00:00:00Z' });
    await indexRsvp({ uri: 'at://did:plc:idxtestB/community.lexicon.calendar.rsvp/r2', eventUri, attendeeDid: 'did:plc:idxtestB', status: 'going', createdAt: '2026-06-25T00:00:00Z' });
    const { counts } = await listRsvps(eventUri);
    expect(counts.going).toBe(2);
  });
});

describe('forum-index hidden visibility', () => {
  const COMM = 'did:plc:idxhiddencomm';
  const AUTHOR = 'did:plc:idxhiddenauthor';
  const threadUri = `at://${AUTHOR}/net.openfederation.forum.thread/ht1`;
  const postUri = `at://${AUTHOR}/net.openfederation.forum.post/hp1`;

  beforeAll(async () => {
    await query('DELETE FROM forum_posts WHERE community_did = $1', [COMM]);
    await query('DELETE FROM forum_threads WHERE community_did = $1', [COMM]);
    await indexThread({ uri: threadUri, cid: 'bafyh1', communityDid: COMM, authorDid: AUTHOR, title: 'Hidden viz', tags: [], createdAt: '2026-07-01T00:00:00Z' });
    await indexPost({ uri: postUri, cid: 'bafyh2', communityDid: COMM, authorDid: AUTHOR, threadRootUri: threadUri, parentUri: null, record: { text: 'target' }, createdAt: '2026-07-01T00:01:00Z' });
  });

  it('setThreadHidden hides a thread from listThreads; includeHidden restores it with hidden flag', async () => {
    await setThreadHidden(threadUri, true);

    const publicRows = await listThreads(COMM, 50, null);
    expect(publicRows.map(t => t.uri)).not.toContain(threadUri);

    const modRows = await listThreads(COMM, 50, null, { includeHidden: true });
    const row = modRows.find(t => t.uri === threadUri);
    expect(row).toBeDefined();
    expect(row?.hidden).toBe(true);

    await setThreadHidden(threadUri, false);
    const restored = await listThreads(COMM, 50, null);
    const restoredRow = restored.find(t => t.uri === threadUri);
    expect(restoredRow).toBeDefined();
    expect(restoredRow?.hidden).toBe(false);
  });

  it('getThreadPosts excludes hidden posts publicly; includeHidden includes them with hidden flag', async () => {
    await setPostHidden(postUri, true);

    const publicPosts = await getThreadPosts(threadUri, 50, null);
    expect(publicPosts.map(p => p.uri)).not.toContain(postUri);

    const modPosts = await getThreadPosts(threadUri, 50, null, { includeHidden: true });
    const row = modPosts.find(p => p.uri === postUri);
    expect(row).toBeDefined();
    expect(row?.hidden).toBe(true);

    await setPostHidden(postUri, false);
    const restored = await getThreadPosts(threadUri, 50, null);
    expect(restored.find(p => p.uri === postUri)?.hidden).toBe(false);
  });
});
