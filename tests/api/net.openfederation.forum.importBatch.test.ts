/**
 * Discord import (#86), end to end against the fixture export: the mapping
 * and runner from the CLI, writing through net.openfederation.forum.importBatch.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createTestUser, getAdminToken, isPLCAvailable, uniqueHandle, xrpcAuthGet, xrpcAuthPost, xrpcGet,
} from './helpers.js';
import { readExportDir, mapExport, type ImportPlan } from '../../cli/discord-export.js';
import {
  newCheckpoint, loadCheckpoint, planBatches, runImport, createInvites, inviteesFor, invitesCsv,
  type ImportTransport, type ImportBatchBody, type StatusError,
} from '../../cli/discord-import.js';
import { readMembersCsv } from '../../cli/discord-export.js';
import { snowflakeRkey } from '../../src/forum/import.js';
import { query } from '../../src/db/client.js';

const FIXTURE = join(__dirname, '..', 'fixtures', 'discord');
const NSID = 'net.openfederation.forum.importBatch';
const GUILD = '1000000000000000001';

function transportFor(token: string, adminToken?: string): ImportTransport & { calls: number } {
  const t = {
    calls: 0,
    async importBatch(body: ImportBatchBody) {
      t.calls++;
      const res = await xrpcAuthPost(NSID, token, body);
      if (res.status !== 200) {
        const err = new Error(`${res.status} ${res.body.error}: ${res.body.message}`) as StatusError;
        err.status = res.status;
        throw err;
      }
      return res.body;
    },
    async createInvites(count: number, note?: string) {
      const res = await xrpcAuthPost('net.openfederation.invite.create', adminToken ?? token, { count, maxUses: 1, ...(note ? { note } : {}) });
      if (res.status !== 201) {
        const err = new Error(`${res.status} ${res.body.error}`) as StatusError;
        err.status = res.status;
        throw err;
      }
      return res.body.codes as string[];
    },
  };
  return t;
}

const checkpointPath = () => join(mkdtempSync(join(tmpdir(), 'ofc-import-')), 'checkpoint.json');

async function forumRecords(did: string): Promise<Array<{ collection: string; rkey: string; record: Record<string, unknown> }>> {
  const rows = await query<{ collection: string; rkey: string; record: Record<string, unknown> }>(
    `SELECT collection, rkey, record FROM records_index
     WHERE community_did = $1 AND collection IN ('net.openfederation.forum.thread', 'net.openfederation.forum.post')`,
    [did],
  );
  return rows.rows;
}

describe('net.openfederation.forum.importBatch — Discord import', () => {
  let plc = false;
  let owner: { accessJwt: string; did: string };
  let member: { accessJwt: string; did: string };
  let outsider: { accessJwt: string; did: string };
  let adminToken: string;
  let plan: ImportPlan;

  const newCommunity = async (visibility: 'public' | 'private' = 'public') => {
    const res = await xrpcAuthPost('net.openfederation.community.create', owner.accessJwt, {
      handle: uniqueHandle('imp'), didMethod: 'plc', visibility, joinPolicy: 'open',
    });
    expect(res.status).toBe(201);
    return res.body.did as string;
  };

  beforeAll(async () => {
    plc = await isPLCAvailable();
    if (!plc) return;
    adminToken = await getAdminToken();
    owner = await createTestUser(uniqueHandle('imp-owner'));
    member = await createTestUser(uniqueHandle('imp-member'));
    outsider = await createTestUser(uniqueHandle('imp-out'));
    plan = mapExport(readExportDir(FIXTURE));
  });

  it('dry run: reports what would be created and writes nothing', async () => {
    if (!plc) return;
    const did = await newCommunity();
    const batches = planBatches(plan, did, null);
    expect(plan.report).toMatchObject({ threads: 3, posts: 10, skipped: { botMessages: 1, systemMessages: 2, privateThreads: 1 } });
    expect(batches).toHaveLength(3);
    expect(await forumRecords(did)).toEqual([]);
    const list = await xrpcAuthGet('net.openfederation.forum.listThreads', owner.accessJwt, { community: did });
    expect(list.body.threads).toEqual([]);
  });

  describe('applied to a public community', () => {
    let did: string;
    let path: string;

    beforeAll(async () => {
      if (!plc) return;
      did = await newCommunity();
      path = checkpointPath();
      const totals = await runImport(plan, newCheckpoint(did, GUILD, false), transportFor(owner.accessJwt), { checkpointPath: path });
      expect(totals).toMatchObject({ batches: 3, threads: { created: 3, existing: 0 }, posts: { created: 10, existing: 0 } });
    });

    it('creates the threads and posts in the community repo, keyed by the Discord ids', async () => {
      if (!plc) return;
      const records = await forumRecords(did);
      expect(records.filter((r) => r.collection.endsWith('.thread'))).toHaveLength(3);
      expect(records.filter((r) => r.collection.endsWith('.post'))).toHaveLength(10);
      const keys = new Set(records.map((r) => r.rkey));
      expect(keys.has(snowflakeRkey('1100000000000000010'))).toBe(true);
      expect(keys.has(snowflakeRkey('1200000000000000203'))).toBe(true);
      for (const r of records) {
        expect(r.record.author).toBeUndefined();
        expect(r.record.community).toBe(did);
      }
    });

    it('lists the threads and serves posts in order with their original time and marker', async () => {
      if (!plc) return;
      const list = await xrpcGet('net.openfederation.forum.listThreads', { community: did });
      expect(list.status).toBe(200);
      const titles = list.body.threads.map((t: { title: string }) => t.title).sort();
      expect(titles).toEqual(['#events', '#general', 'Dune discussion']);
      const general = list.body.threads.find((t: { title: string }) => t.title === '#general');
      expect(general.authorDid).toBe(did);
      expect(general.postCount).toBe(5);

      const thread = await xrpcGet('net.openfederation.forum.getThread', { uri: general.uri });
      expect(thread.status).toBe(200);
      const posts = thread.body.posts;
      expect(posts.map((p: { record: { text: string } }) => p.record.text.slice(0, 10))).toEqual([
        'Welcome to', 'Hi all 👋 ', '@Discord m', 'Photo from', 'Reading tr',
      ]);
      expect(posts[0].record.createdAt).toBe('2026-01-05T18:00:00.000Z');
      expect(posts[0].record.importedFrom).toEqual({
        platform: 'discord', channelId: '1100000000000000010', messageId: '1200000000000000001', author: 'Discord member 1',
      });
      expect(posts[1].record.importedFrom.editedAt).toBe('2026-01-05T18:07:30.000Z');
      expect(posts[3].record.importedFrom.attachmentCount).toBe(1);
      // The reply keeps its link to the message it answered.
      expect(posts[2].parentUri).toBe(posts[1].uri);
      expect(posts[2].record.parent).toEqual({ uri: posts[1].uri, cid: posts[1].cid });
      expect(posts[2].record.root.uri).toBe(general.uri);
    });

    it('a second run creates nothing new', async () => {
      if (!plc) return;
      // With the checkpoint: nothing left to send.
      const cp = loadCheckpoint(path)!;
      expect(planBatches(plan, did, cp)).toEqual([]);
      // Without it (lost, or a different machine): everything is sent again, and nothing is created.
      const t = transportFor(owner.accessJwt);
      const totals = await runImport(plan, newCheckpoint(did, GUILD, false), t, { checkpointPath: checkpointPath() });
      expect(totals).toMatchObject({ threads: { created: 0, existing: 3 }, posts: { created: 0, existing: 10 } });
      expect(await forumRecords(did)).toHaveLength(13);
      const list = await xrpcGet('net.openfederation.forum.listThreads', { community: did });
      expect(list.body.threads.find((x: { title: string }) => x.title === '#general').postCount).toBe(5);
    });

    it('creates one single-use invite per member, with nothing on the PDS naming them', async () => {
      if (!plc) return;
      const cp = loadCheckpoint(path)!;
      const members = readMembersCsv(join(FIXTURE, 'members.csv'));
      const rows = await createInvites(inviteesFor(plan, members), plan, cp, transportFor(owner.accessJwt, adminToken), { checkpointPath: path });
      expect(rows).toHaveLength(5);
      expect(new Set(rows.map((r) => r.code)).size).toBe(5);
      expect(rows[0]).toMatchObject({ discordName: 'Alice', importedAs: 'Discord member 1' });
      const stored = await query<{ max_uses: number; note: string | null; bound_to: string | null }>(
        'SELECT max_uses, note, bound_to FROM invites WHERE code = ANY($1)', [rows.map((r) => r.code)],
      );
      expect(stored.rows).toHaveLength(5);
      for (const r of stored.rows) expect(r).toEqual({ max_uses: 1, note: null, bound_to: null });
      // A re-run hands out the same codes.
      const again = await createInvites(inviteesFor(plan, members), plan, loadCheckpoint(path)!, transportFor(owner.accessJwt, adminToken), { checkpointPath: path });
      expect(again.map((r) => r.code)).toEqual(rows.map((r) => r.code));
      expect(invitesCsv(rows, 'https://ui.example/register').split('\n')[1]).toContain('?invite=');
      // The checkpoint keeps the mapping locally; it is never sent.
      expect(JSON.parse(readFileSync(path, 'utf-8')).pseudonyms['1000000000000000101']).toBe('Discord member 1');
    });
  });

  it('an interrupted run resumes where it stopped', async () => {
    if (!plc) return;
    const did = await newCommunity();
    const path = checkpointPath();
    const real = transportFor(owner.accessJwt);
    let sent = 0;
    const flaky: ImportTransport = {
      ...real,
      async importBatch(body) {
        if (++sent === 2) {
          const err = new Error('connection reset') as StatusError;
          throw err;
        }
        return real.importBatch(body);
      },
    };
    await expect(runImport(plan, newCheckpoint(did, GUILD, false), flaky, { checkpointPath: path })).rejects.toThrow(/connection reset/);
    expect(await forumRecords(did)).toHaveLength(1 + 5);

    const cp = loadCheckpoint(path)!;
    expect(cp.threadsDone).toEqual(['1100000000000000010']);
    expect(planBatches(plan, did, cp)).toHaveLength(2);
    const resumed = transportFor(owner.accessJwt);
    const totals = await runImport(plan, cp, resumed, { checkpointPath: path });
    expect(resumed.calls).toBe(2);
    expect(totals).toMatchObject({ threads: { created: 2, existing: 0 }, posts: { created: 5, existing: 0 } });
    expect(await forumRecords(did)).toHaveLength(13);
  });

  it('waits and retries when rate limited', async () => {
    if (!plc) return;
    const did = await newCommunity();
    const real = transportFor(owner.accessJwt);
    let first = true;
    const waits: number[] = [];
    const limited: ImportTransport = {
      ...real,
      async importBatch(body) {
        if (first) {
          first = false;
          const err = new Error('Too many import batches') as StatusError;
          err.status = 429;
          err.retryAfterSeconds = 7;
          throw err;
        }
        return real.importBatch(body);
      },
    };
    const totals = await runImport(plan, newCheckpoint(did, GUILD, false), limited, {
      checkpointPath: checkpointPath(), sleep: async (ms) => { waits.push(ms); },
    });
    expect(waits).toEqual([7000]);
    expect(totals.posts.created).toBe(10);
  });

  it('refuses anyone but the owner (or a PDS admin)', async () => {
    if (!plc) return;
    const did = await newCommunity();
    await xrpcAuthPost('net.openfederation.community.join', member.accessJwt, { did });
    const body = planBatches(plan, did, null)[0].body;

    const asMember = await xrpcAuthPost(NSID, member.accessJwt, body);
    expect(asMember.status).toBe(403);
    const asOutsider = await xrpcAuthPost(NSID, outsider.accessJwt, body);
    expect(asOutsider.status).toBe(403);
    const anonymous = await xrpcGet(NSID);
    expect([401, 405]).toContain(anonymous.status);
    expect(await forumRecords(did)).toEqual([]);

    const asAdmin = await xrpcAuthPost(NSID, adminToken, body);
    expect(asAdmin.status).toBe(200);
  });

  it('refuses a malformed batch, a post without its thread, and a reply to nothing', async () => {
    if (!plc) return;
    const did = await newCommunity();
    const base = { community: did, platform: 'discord' };
    const post = { channelId: '1100000000000000010', messageId: '1200000000000000001', text: 'hi', createdAt: '2026-01-05T18:00:00Z' };

    const undeclared = await xrpcAuthPost(NSID, owner.accessJwt, { ...base, posts: [{ ...post, author: 'x', rkey: 'abc' }] });
    expect(undeclared.status).toBe(400);
    const noThread = await xrpcAuthPost(NSID, owner.accessJwt, { ...base, posts: [post] });
    expect(noThread.status).toBe(400);
    expect(noThread.body.error).toBe('ThreadNotFound');
    const noParent = await xrpcAuthPost(NSID, owner.accessJwt, {
      ...base,
      threads: [{ channelId: post.channelId, title: '#general', tags: [], createdAt: post.createdAt }],
      posts: [{ ...post, replyToMessageId: '1200000000000000000' }],
    });
    expect(noParent.status).toBe(400);
    expect(noParent.body.error).toBe('ParentNotFound');
    // Refusals are all-or-nothing.
    expect(await forumRecords(did)).toEqual([]);
  });

  describe('into a private community', () => {
    let did: string;

    beforeAll(async () => {
      if (!plc) return;
      did = await newCommunity('private');
      await runImport(plan, newCheckpoint(did, GUILD, false), transportFor(owner.accessJwt), { checkpointPath: checkpointPath() });
    });

    it('members read the imported history', async () => {
      if (!plc) return;
      const list = await xrpcAuthGet('net.openfederation.forum.listThreads', owner.accessJwt, { community: did });
      expect(list.status).toBe(200);
      expect(list.body.threads).toHaveLength(3);
    });

    it('outsiders cannot list, open or fetch it from the repository', async () => {
      if (!plc) return;
      const list = await xrpcAuthGet('net.openfederation.forum.listThreads', outsider.accessJwt, { community: did });
      expect(list.status).toBe(404);
      const threadUri = `at://${did}/net.openfederation.forum.thread/${snowflakeRkey('1100000000000000010')}`;
      expect((await xrpcGet('net.openfederation.forum.getThread', { uri: threadUri })).status).toBe(404);
      const record = await xrpcGet('com.atproto.repo.getRecord', {
        repo: did, collection: 'net.openfederation.forum.post', rkey: snowflakeRkey('1200000000000000001'),
      });
      expect(record.status).toBe(404);
      const listed = await xrpcGet('com.atproto.repo.listRecords', { repo: did, collection: 'net.openfederation.forum.post' });
      expect(listed.status).toBe(404);
    });
  });
});
