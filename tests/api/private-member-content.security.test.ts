/**
 * What members write in a private community stays in the community. It is
 * stored in the community's own repository, which only members can read, and
 * carries the author's signature so authorship is still provable. A public
 * community keeps working the way it always has: content in the author's repo.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import {
  xrpcGet, xrpcAuthPost, xrpcAuthGet, createTestUser, isPLCAvailable, uniqueHandle,
} from './helpers.js';
import { query } from '../../src/db/client.js';
import { verifyAuthorSignature } from '../../src/forum/member-content.js';

type User = { accessJwt: string; did: string; handle: string };
const THREAD = 'net.openfederation.forum.thread';
const POST = 'net.openfederation.forum.post';
const RSVP = 'community.lexicon.calendar.rsvp';
const MEMBER_CONTENT = [THREAD, POST, RSVP];

const recordsIn = async (repo: string, collection: string) => (await query<{ rkey: string; record: any }>(
  'SELECT rkey, record FROM records_index WHERE community_did = $1 AND collection = $2', [repo, collection])).rows;
const repoOf = (uri: string) => uri.split('/')[2];

describe('member content in private communities', () => {
  let plc: boolean;
  let owner: User, member: User, other: User;

  beforeAll(async () => {
    plc = await isPLCAvailable();
    if (!plc) return;
    owner = await createTestUser(uniqueHandle('pmc-owner'));
    member = await createTestUser(uniqueHandle('pmc-member'));
    other = await createTestUser(uniqueHandle('pmc-other'));
  });

  async function community(visibility: 'public' | 'private'): Promise<string> {
    const created = await xrpcAuthPost('net.openfederation.community.create', owner.accessJwt, {
      handle: uniqueHandle('pmc'), didMethod: 'plc', visibility, joinPolicy: 'open',
    });
    expect(created.status).toBe(201);
    for (const u of [member, other]) {
      const joined = await xrpcAuthPost('net.openfederation.community.join', u.accessJwt, { did: created.body.did });
      expect(joined.body.status).toBe('joined');
    }
    return created.body.did;
  }
  const thread = (who: User, c: string, title = 'Topic') =>
    xrpcAuthPost('net.openfederation.forum.createThread', who.accessJwt, { community: c, title });
  const post = (who: User, c: string, root: { uri: string; cid: string }, text = 'hello') =>
    xrpcAuthPost('net.openfederation.forum.createPost', who.accessJwt, { community: c, root, text });

  describe('a private community', () => {
    let c: string;
    let t: { uri: string; cid: string };
    let p: { uri: string; cid: string; rkey: string };
    let memberBefore: number;

    beforeAll(async () => {
      if (!plc) return;
      c = await community('private');
      memberBefore = (await Promise.all(MEMBER_CONTENT.map((col) => recordsIn(member.did, col)))).flat().length;
      const tr = await thread(member, c, 'Members only');
      expect(tr.status).toBe(200);
      t = tr.body;
      const pr = await post(member, c, t, 'a private reply');
      expect(pr.status).toBe(200);
      p = pr.body;
    });

    it('stores threads and posts in the community repository, not the author\'s', async () => {
      if (!plc) return;
      expect(repoOf(t.uri)).toBe(c);
      expect(repoOf(p.uri)).toBe(c);
      const memberNow = (await Promise.all(MEMBER_CONTENT.map((col) => recordsIn(member.did, col)))).flat().length;
      expect(memberNow).toBe(memberBefore);
    });

    it('leaves nothing for the public to read in the author\'s repository', async () => {
      if (!plc) return;
      for (const collection of [THREAD, POST]) {
        const res = await xrpcGet('com.atproto.repo.listRecords', { repo: member.did, collection });
        const text = JSON.stringify(res.body);
        expect(text).not.toContain('Members only');
        expect(text).not.toContain('a private reply');
        expect(text).not.toContain(c);
      }
      // The community repository itself answers outsiders as if it did not exist.
      const outside = await xrpcGet('com.atproto.repo.listRecords', { repo: c, collection: POST });
      expect(outside.status).toBe(404);
    });

    it('records who wrote it, with a signature by the author that verifies', async () => {
      if (!plc) return;
      const [stored] = (await recordsIn(c, POST)).filter((r) => r.rkey === p.rkey);
      expect(stored.record.author).toBe(member.did);
      expect(await verifyAuthorSignature(stored.record)).toBe(true);
      // Change a word and the signature no longer covers it.
      expect(await verifyAuthorSignature({ ...stored.record, text: 'something else' })).toBe(false);
      // Claim someone else wrote it and it does not verify either.
      expect(await verifyAuthorSignature({ ...stored.record, author: other.did })).toBe(false);
    });

    it('still shows members the thread, attributed to its author', async () => {
      if (!plc) return;
      const res = await xrpcAuthGet('net.openfederation.forum.getThread', other.accessJwt, { uri: t.uri });
      expect(res.status).toBe(200);
      expect(res.body.thread.authorDid).toBe(member.did);
      expect(res.body.posts.map((x: any) => x.authorDid)).toEqual([member.did]);
    });

    it('lets the author delete their own post, and nobody else', async () => {
      if (!plc) return;
      const mine = await post(member, c, t, 'to be deleted');
      const notYours = await xrpcAuthPost('net.openfederation.forum.deletePost', other.accessJwt, { rkey: mine.body.rkey });
      expect(notYours.status).toBe(404);
      const ok = await xrpcAuthPost('net.openfederation.forum.deletePost', member.accessJwt, { rkey: mine.body.rkey });
      expect(ok.status).toBe(200);
      expect((await recordsIn(c, POST)).some((r) => r.rkey === mine.body.rkey)).toBe(false);
    });

    it('stores RSVPs in the community repository too, one per person per event', async () => {
      if (!plc) return;
      const ev = await xrpcAuthPost('net.openfederation.calendar.createEvent', owner.accessJwt, { community: c, name: 'Meetup' });
      const before = (await recordsIn(member.did, RSVP)).length;
      for (const status of ['going', 'interested', 'going']) {
        const r = await xrpcAuthPost('net.openfederation.calendar.rsvp', member.accessJwt, {
          community: c, event: { uri: ev.body.uri, cid: ev.body.cid }, status,
        });
        expect(r.status).toBe(200);
        expect(repoOf(r.body.uri)).toBe(c);
      }
      expect((await recordsIn(member.did, RSVP)).length).toBe(before);
      const mine = (await recordsIn(c, RSVP)).filter((r) => r.record.author === member.did && r.record.subject?.uri === ev.body.uri);
      expect(mine).toHaveLength(1);
      expect(mine[0].record.status).toBe('going');
      expect(await verifyAuthorSignature(mine[0].record)).toBe(true);
    });
  });

  describe('a public community', () => {
    it('is unchanged: content lives in the author\'s own repository', async () => {
      if (!plc) return;
      const c = await community('public');
      const tr = await thread(member, c, 'Open topic');
      expect(repoOf(tr.body.uri)).toBe(member.did);
      const pr = await post(member, c, tr.body, 'open reply');
      expect(repoOf(pr.body.uri)).toBe(member.did);
      expect((await recordsIn(c, POST)).length).toBe(0);
      const del = await xrpcAuthPost('net.openfederation.forum.deletePost', member.accessJwt, { rkey: pr.body.rkey });
      expect(del.status).toBe(200);
    });
  });

  describe('a community that becomes private', () => {
    it('takes its existing member content out of the authors\' public repositories', async () => {
      if (!plc) return;
      const c = await community('public');
      const tr = await thread(member, c, 'Was public');
      const p1 = await post(other, c, tr.body, 'first reply');
      const p2 = await post(member, c, tr.body, 'second reply');
      expect(p1.status).toBe(200);
      expect(p2.status).toBe(200);

      const made = await xrpcAuthPost('net.openfederation.community.update', owner.accessJwt, { did: c, visibility: 'private' });
      expect(made.status).toBe(200);

      // Gone from the authors' repositories...
      for (const u of [member, other]) {
        for (const col of [THREAD, POST]) {
          expect((await recordsIn(u.did, col)).filter((r) => r.record.community === c)).toHaveLength(0);
        }
      }
      // ...and present, signed and attributed, in the community's.
      const threads = await recordsIn(c, THREAD);
      const posts = await recordsIn(c, POST);
      expect(threads).toHaveLength(1);
      expect(posts).toHaveLength(2);
      expect(threads[0].record.author).toBe(member.did);
      expect(posts.map((r) => r.record.author).sort()).toEqual([member.did, other.did].sort());
      for (const r of [...threads, ...posts]) expect(await verifyAuthorSignature(r.record)).toBe(true);

      // Replies still point at the thread, at its new address.
      const newThreadUri = `at://${c}/${THREAD}/${threads[0].rkey}`;
      for (const r of posts) expect(r.record.root.uri).toBe(newThreadUri);

      // Members still see one thread with both replies, in order.
      const list = await xrpcAuthGet('net.openfederation.forum.listThreads', member.accessJwt, { community: c });
      expect(list.body.threads).toHaveLength(1);
      expect(list.body.threads[0].uri).toBe(newThreadUri);
      expect(list.body.threads[0].postCount).toBe(2);
      const view = await xrpcAuthGet('net.openfederation.forum.getThread', member.accessJwt, { uri: newThreadUri });
      expect(view.body.posts.map((x: any) => x.record.text)).toEqual(['first reply', 'second reply']);
    });
  });
});
