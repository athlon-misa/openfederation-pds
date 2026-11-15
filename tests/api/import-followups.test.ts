/**
 * Import follow-ups (#403), server side: Slack ids in forum.importBatch,
 * attachments as community blobs (forum.importBlob, linked as `embeds`),
 * deleted imported posts staying deleted, and community invite codes.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import {
  api, createTestUser, getAdminToken, isPLCAvailable, uniqueHandle, xrpcAuthGet, xrpcAuthPost, xrpcGet, xrpcPost,
} from './helpers.js';
import { query } from '../../src/db/client.js';
import { postRkey, threadRkey, snowflakeRkey, isSlackTs } from '../../src/forum/import.js';
import { refreshRuntimeSettings } from '../../src/settings/runtime-settings.js';
import { sniffImageType } from '../../src/blob/sniff.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSlackExport, mapSlackExport } from '../../cli/slack-export.js';
import { readExportDir, mapExport } from '../../cli/discord-export.js';
import {
  newCheckpoint, runImport, createInvites, inviteesFor, type ImportTransport, type ImportBatchBody, type StatusError,
} from '../../cli/discord-import.js';

const SLACK_FIXTURE = join(__dirname, '..', 'fixtures', 'slack');
const DISCORD_MEDIA = join(__dirname, '..', 'fixtures', 'discord-media');

function serverTransport(token: string): ImportTransport {
  const fail = (res: { status: number; body: { error?: string; message?: string } }) => {
    const err = new Error(`${res.status} ${res.body.error}: ${res.body.message}`) as StatusError;
    err.status = res.status;
    return err;
  };
  return {
    async importBatch(body: ImportBatchBody) {
      const res = await xrpcAuthPost(BATCH, token, body);
      if (res.status !== 200) throw fail(res);
      return res.body;
    },
    async uploadBlob(community: string, data: Buffer, mimeType: string) {
      const res = await uploadBlob(token, community, data, mimeType);
      if (res.status !== 200) throw fail(res);
      return res.body.blob;
    },
    async createInvites(count: number, note?: string, community?: string) {
      const res = await xrpcAuthPost('net.openfederation.invite.create', token, { count, maxUses: 1, ...(note ? { note } : {}), ...(community ? { community } : {}) });
      if (res.status !== 201) throw fail(res);
      return res.body.codes as string[];
    },
  };
}
const checkpoint = () => join(mkdtempSync(join(tmpdir(), 'ofc-403-api-')), 'checkpoint.json');

const BATCH = 'net.openfederation.forum.importBatch';
const BLOB = 'net.openfederation.forum.importBlob';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const PASSWORD = 'TestPassword123!';

function uploadBlob(token: string, community: string, body: Buffer, type: string) {
  return api.post(`/xrpc/${BLOB}?community=${encodeURIComponent(community)}`)
    .set('Authorization', `Bearer ${token}`).set('Content-Type', type).send(body);
}

describe('blob sniffing', () => {
  it('recognises the allowed image types by their bytes only', () => {
    expect(sniffImageType(PNG)).toBe('image/png');
    expect(sniffImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).toBe('image/jpeg');
    expect(sniffImageType(Buffer.from('GIF89a......'))).toBe('image/gif');
    expect(sniffImageType(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
    expect(sniffImageType(Buffer.from('MZ\x90\0\x03\0\0\0'))).toBeNull(); // a Windows executable
    expect(sniffImageType(Buffer.from('\x7fELF\x02\x01\x01'))).toBeNull();
    expect(sniffImageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'))).toBeNull();
    expect(sniffImageType(Buffer.from('%PDF-1.7'))).toBeNull();
    expect(sniffImageType(Buffer.alloc(0))).toBeNull();
  });
});

describe('Slack record keys', () => {
  it('are well-formed TIDs, deterministic, distinct per channel, and in time order', () => {
    const a = postRkey('slack', 'C0AAAAAAA', '1767614400.000100');
    expect(a).toMatch(/^[234567abcdefghij][234567abcdefghijklmnopqrstuvwxyz]{12}$/);
    expect(postRkey('slack', 'C0AAAAAAA', '1767614400.000100')).toBe(a);
    expect(postRkey('slack', 'C0BBBBBBB', '1767614400.000100')).not.toBe(a);
    expect(postRkey('slack', 'C0AAAAAAA', '1767614400.000101') > a).toBe(true);
    expect(postRkey('slack', 'C0AAAAAAA', '1767614401.000000') > postRkey('slack', 'C0AAAAAAA', '1767614400.999999')).toBe(true);
    expect(threadRkey('slack', 'C0AAAAAAA')).not.toBe(threadRkey('slack', 'C0BBBBBBB'));
    // Channel keys sort below every message key.
    expect(threadRkey('slack', 'C0AAAAAAA') < postRkey('slack', 'C0AAAAAAA', '1356998700.000000')).toBe(true);
    // Discord keys are unchanged.
    expect(threadRkey('discord', '1100000000000000010')).toBe(snowflakeRkey('1100000000000000010'));
    expect(isSlackTs('1767614400.000100')).toBe(true);
    expect(isSlackTs('1767614400.1')).toBe(false);
    expect(() => postRkey('slack', 'C0AAAAAAA', '1000000000.000000')).toThrow(/out of range/);
  });
});

describe('import follow-ups against the server', () => {
  let plc = false;
  let adminToken: string;
  let owner: { accessJwt: string; did: string };
  let other: { accessJwt: string; did: string };

  const newCommunity = async (opts: { visibility?: 'public' | 'private'; joinPolicy?: 'open' | 'approval' } = {}) => {
    const res = await xrpcAuthPost('net.openfederation.community.create', owner.accessJwt, {
      handle: uniqueHandle('i403'), didMethod: 'plc', visibility: opts.visibility ?? 'public', joinPolicy: opts.joinPolicy ?? 'open',
    });
    expect(res.status).toBe(201);
    return res.body.did as string;
  };

  beforeAll(async () => {
    plc = await isPLCAvailable();
    if (!plc) return;
    adminToken = await getAdminToken();
    owner = await createTestUser(uniqueHandle('i403-owner'));
    other = await createTestUser(uniqueHandle('i403-other'));
  });

  describe('Slack batches', () => {
    it('writes channels and messages keyed by the Slack ids, thread replies linked to their parent', async () => {
      if (!plc) return;
      const did = await newCommunity();
      const body = {
        community: did, platform: 'slack',
        threads: [{ channelId: 'C0GENERAL1', title: '#general', tags: ['slack'], createdAt: '2026-01-05T09:00:00.000Z' }],
        posts: [
          { channelId: 'C0GENERAL1', messageId: '1767603600.000100', text: 'Morning all', createdAt: '2026-01-05T09:00:00.000Z', author: 'Slack member 1' },
          { channelId: 'C0GENERAL1', messageId: '1767603660.000200', replyToMessageId: '1767603600.000100', text: 'Morning!', createdAt: '2026-01-05T09:01:00.000Z', author: 'Slack member 2' },
        ],
      };
      const res = await xrpcAuthPost(BATCH, owner.accessJwt, body);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ threads: { created: 1, existing: 0, deleted: 0 }, posts: { created: 2, existing: 0, deleted: 0 } });
      const again = await xrpcAuthPost(BATCH, owner.accessJwt, body);
      expect(again.body).toEqual({ threads: { created: 0, existing: 1, deleted: 0 }, posts: { created: 0, existing: 2, deleted: 0 } });

      const rows = (await query<{ rkey: string; record: Record<string, any> }>(
        `SELECT rkey, record FROM records_index WHERE community_did = $1 AND collection = 'net.openfederation.forum.post' ORDER BY rkey`, [did])).rows;
      expect(rows.map((r) => r.rkey)).toEqual([
        postRkey('slack', 'C0GENERAL1', '1767603600.000100'), postRkey('slack', 'C0GENERAL1', '1767603660.000200'),
      ]);
      expect(rows[0].record.importedFrom).toEqual({
        platform: 'slack', channelId: 'C0GENERAL1', messageId: '1767603600.000100', author: 'Slack member 1',
      });
      expect(rows[1].record.parent.uri).toBe(`at://${did}/net.openfederation.forum.post/${rows[0].rkey}`);
    });

    it('refuses Discord-style ids for Slack, direct-message channels and malformed timestamps', async () => {
      if (!plc) return;
      const did = await newCommunity();
      const thread = (channelId: string) => ({ channelId, title: 't', tags: [], createdAt: '2026-01-05T09:00:00.000Z' });
      for (const threads of [[thread('1100000000000000010')], [thread('D0DIRECT1')], [thread('c0lower')]]) {
        const res = await xrpcAuthPost(BATCH, owner.accessJwt, { community: did, platform: 'slack', threads });
        expect(res.status).toBe(400);
      }
      const res = await xrpcAuthPost(BATCH, owner.accessJwt, {
        community: did, platform: 'slack', threads: [thread('C0GENERAL1')],
        posts: [{ channelId: 'C0GENERAL1', messageId: '1767603600', text: 'x', createdAt: '2026-01-05T09:00:00.000Z' }],
      });
      expect(res.status).toBe(400);
    });
  });

  describe('attachments as community blobs', () => {
    let did: string;
    beforeAll(async () => {
      if (!plc) return;
      did = await newCommunity();
    });

    it('stores an image for the community and lets a post link it', async () => {
      if (!plc) return;
      const up = await uploadBlob(owner.accessJwt, did, PNG, 'image/png');
      expect(up.status).toBe(200);
      expect(up.body.blob).toMatchObject({ $type: 'blob', mimeType: 'image/png', size: PNG.length });
      const owned = await query('SELECT 1 FROM blob_owners WHERE cid = $1 AND did = $2', [up.body.blob.ref.$link, did]);
      expect(owned.rows).toHaveLength(1);

      const res = await xrpcAuthPost(BATCH, owner.accessJwt, {
        community: did, platform: 'discord',
        threads: [{ channelId: '1100000000000000010', title: '#general', tags: ['discord'], createdAt: '2026-01-05T18:00:00.000Z' }],
        posts: [{
          channelId: '1100000000000000010', messageId: '1200000000000000001', text: 'Photo', createdAt: '2026-01-05T18:00:00.000Z',
          attachmentCount: 2, embeds: [up.body.blob],
        }],
      });
      expect(res.status).toBe(200);
      const post = (await query<{ record: Record<string, any> }>(
        `SELECT record FROM records_index WHERE community_did = $1 AND rkey = $2`, [did, snowflakeRkey('1200000000000000001')])).rows[0];
      expect(post.record.embeds).toEqual([up.body.blob]);
      expect(post.record.importedFrom.attachmentCount).toBe(2);

      // Served from the community's repository.
      const served = await xrpcGet('com.atproto.sync.getBlob', { did, cid: up.body.blob.ref.$link });
      expect(served.status).toBe(200);
      expect(served.headers['content-type']).toBe('image/png');
    });

    it('refuses a file whose bytes are not the image type it claims, and types that are not images', async () => {
      if (!plc) return;
      const exe = Buffer.from('MZ\x90\0\x03\0\0\0\x04\0\0\0\xff\xff\0\0', 'latin1');
      expect((await uploadBlob(owner.accessJwt, did, exe, 'image/png')).status).toBe(400);
      expect((await uploadBlob(owner.accessJwt, did, exe, 'application/octet-stream')).status).toBe(400);
      expect((await uploadBlob(owner.accessJwt, did, Buffer.from('<svg/>'), 'image/svg+xml')).status).toBe(400);
      expect((await uploadBlob(owner.accessJwt, did, PNG, 'image/jpeg')).body.error).toBe('InvalidMimeType');
    });

    it('refuses a file over the limit', async () => {
      if (!plc) return;
      const big = Buffer.concat([PNG, Buffer.alloc(1_000_001)]);
      const res = await uploadBlob(owner.accessJwt, did, big, 'image/png');
      expect(res.status).toBe(413);
    });

    it('is the owner\'s: another account may not upload for the community', async () => {
      if (!plc) return;
      const res = await uploadBlob(other.accessJwt, did, PNG, 'image/png');
      expect([403, 404]).toContain(res.status);
    });

    it('a post may not link a blob that was not uploaded for this community', async () => {
      if (!plc) return;
      // Uploaded for the owner's own repository, not the community's.
      const own = await api.post('/xrpc/com.atproto.repo.uploadBlob')
        .set('Authorization', `Bearer ${owner.accessJwt}`).set('Content-Type', 'image/gif')
        .send(Buffer.from('GIF89a\x01\0\x01\0\0\0\0;', 'latin1'));
      expect(own.status).toBe(200);
      const res = await xrpcAuthPost(BATCH, owner.accessJwt, {
        community: did, platform: 'discord',
        posts: [{
          channelId: '1100000000000000010', messageId: '1200000000000000002', text: 'x', createdAt: '2026-01-05T18:01:00.000Z',
          attachmentCount: 1, embeds: [own.body.blob],
        }],
      });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/no such blob uploaded for this community/);
    });
  });

  describe('deleted imported posts stay deleted', () => {
    it('the owner deletes an imported post; a re-import without any checkpoint skips it, and its reply keeps no link', async () => {
      if (!plc) return;
      const did = await newCommunity();
      const body = {
        community: did, platform: 'discord',
        threads: [{ channelId: '1100000000000000010', title: '#general', tags: [], createdAt: '2026-01-05T18:00:00.000Z' }],
        posts: [
          { channelId: '1100000000000000010', messageId: '1200000000000000001', text: 'first', createdAt: '2026-01-05T18:00:00.000Z' },
          { channelId: '1100000000000000010', messageId: '1200000000000000002', text: 'second', createdAt: '2026-01-05T18:01:00.000Z' },
        ],
      };
      expect((await xrpcAuthPost(BATCH, owner.accessJwt, body)).status).toBe(200);
      const rkey = snowflakeRkey('1200000000000000001');

      // Not the author's own post: without `community` it is not found.
      expect((await xrpcAuthPost('net.openfederation.forum.deletePost', owner.accessJwt, { rkey })).status).toBe(404);
      // Someone who does not own the community may not.
      const refused = await xrpcAuthPost('net.openfederation.forum.deletePost', other.accessJwt, { rkey, community: did });
      expect([403, 404]).toContain(refused.status);

      const del = await xrpcAuthPost('net.openfederation.forum.deletePost', owner.accessJwt, { rkey, community: did });
      expect(del.status).toBe(200);
      const tomb = await query('SELECT platform FROM forum_import_tombstones WHERE community_did = $1 AND rkey = $2', [did, rkey]);
      expect(tomb.rows).toEqual([{ platform: 'discord' }]);
      expect((await query('SELECT 1 FROM records_index WHERE community_did = $1 AND rkey = $2', [did, rkey])).rows).toHaveLength(0);

      // The whole import again, as if the checkpoint were lost.
      const again = await xrpcAuthPost(BATCH, owner.accessJwt, body);
      expect(again.status).toBe(200);
      expect(again.body.posts).toEqual({ created: 0, existing: 1, deleted: 1 });
      expect((await query('SELECT 1 FROM records_index WHERE community_did = $1 AND rkey = $2', [did, rkey])).rows).toHaveLength(0);

      // A later message that answered the deleted one is imported without the link.
      const reply = await xrpcAuthPost(BATCH, owner.accessJwt, {
        community: did, platform: 'discord',
        posts: [{
          channelId: '1100000000000000010', messageId: '1200000000000000003', replyToMessageId: '1200000000000000001',
          text: 'third', createdAt: '2026-01-05T18:02:00.000Z',
        }],
      });
      expect(reply.status).toBe(200);
      const third = (await query<{ record: Record<string, unknown> }>(
        'SELECT record FROM records_index WHERE community_did = $1 AND rkey = $2', [did, snowflakeRkey('1200000000000000003')])).rows[0];
      expect(third.record.parent).toBeUndefined();

      // A member's own post is not an imported one.
      const audit = await query<{ meta: Record<string, unknown> }>(
        `SELECT meta FROM audit_log WHERE action = 'forum.post.delete' AND target_id = $1`, [did]);
      expect(audit.rows[0].meta).toMatchObject({ imported: true });
    });
  });

  describe('community invite codes', () => {
    const register = (handle: string, inviteCode: string) => xrpcPost('net.openfederation.account.register', {
      handle, email: `${handle}@test.local`, password: PASSWORD, inviteCode,
    });
    const userId = async (handle: string) => (await query<{ id: string; did: string }>('SELECT id, did FROM users WHERE handle = $1', [handle])).rows[0];
    const isMember = async (community: string, did: string) =>
      (await query('SELECT 1 FROM members_unique WHERE community_did = $1 AND member_did = $2', [community, did])).rows.length === 1;

    beforeEach(async () => {
      await query(`DELETE FROM server_settings WHERE name = 'ACCOUNT_APPROVAL'`);
      await refreshRuntimeSettings();
    });
    afterAll(async () => {
      await query(`DELETE FROM server_settings WHERE name = 'ACCOUNT_APPROVAL'`);
      await refreshRuntimeSettings();
    });

    it('the owner makes them (no admin role needed); others may not; audited with the community', async () => {
      if (!plc) return;
      const did = await newCommunity();
      const made = await xrpcAuthPost('net.openfederation.invite.create', owner.accessJwt, { community: did, count: 2 });
      expect(made.status).toBe(201);
      expect(made.body.codes).toHaveLength(2);
      expect(made.body.community).toBe(did);
      // A plain sign-up code still needs an admin or moderator.
      expect((await xrpcAuthPost('net.openfederation.invite.create', owner.accessJwt, {})).status).toBe(403);
      // Not the owner: as if the community did not exist.
      expect((await xrpcAuthPost('net.openfederation.invite.create', other.accessJwt, { community: did })).status).toBe(404);
      const moderator = await createTestUser(uniqueHandle('i403-mod'), { role: 'moderator' });
      // Changing roles ends the sessions it had; sign in again.
      const modToken = (await xrpcPost('com.atproto.server.createSession', { identifier: moderator.handle, password: PASSWORD })).body.accessJwt;
      expect((await xrpcAuthPost('net.openfederation.invite.create', modToken, {})).status).toBe(201);
      expect((await xrpcAuthPost('net.openfederation.invite.create', modToken, { community: did })).status).toBe(404);
      // A PDS admin may, for any community.
      expect((await xrpcAuthPost('net.openfederation.invite.create', adminToken, { community: did })).status).toBe(201);

      const audit = await query<{ target_id: string; meta: Record<string, unknown> }>(
        `SELECT target_id, meta FROM audit_log WHERE action = 'invite.create' AND target_id = $1 ORDER BY id`, [did]);
      expect(audit.rows[0].meta).toMatchObject({ community: did, count: 2 });

      const list = await xrpcAuthGet('net.openfederation.invite.list', adminToken, { limit: '100' });
      expect(list.status, JSON.stringify(list.body)).toBe(200);
      const listed = list.body.invites.filter((i: { code: string }) => made.body.codes.includes(i.code));
      expect(listed.map((i: { community: string }) => i.community)).toEqual([did, did]);
    });

    it('open community, manual approval: the account joins when an admin approves it', async () => {
      if (!plc) return;
      const did = await newCommunity();
      const code = (await xrpcAuthPost('net.openfederation.invite.create', owner.accessJwt, { community: did })).body.code;
      const handle = uniqueHandle('i403-j1');
      const res = await register(handle, code);
      expect(res.status).toBe(201);
      expect(res.body.status).toBe('pending');
      expect(res.body.community).toEqual({ did, status: 'waitingForApproval' });
      const user = await userId(handle);
      expect(await isMember(did, user.did)).toBe(false);

      const approve = await xrpcAuthPost('net.openfederation.account.approve', adminToken, { userId: user.id });
      expect(approve.status).toBe(200);
      expect(await isMember(did, user.did)).toBe(true);
      expect((await query('SELECT 1 FROM invite_community_joins WHERE user_id = $1', [user.id])).rows).toHaveLength(0);
      const audit = await query<{ meta: Record<string, unknown> }>(
        `SELECT meta FROM audit_log WHERE action = 'community.join' AND actor_id = $1 AND target_id = $2`, [user.id, did]);
      expect(audit.rows[0].meta).toEqual({ via: 'invite', result: 'joined' });

      // Single use.
      expect((await register(uniqueHandle('i403-j1b'), code)).status).toBe(403);
    });

    it('approval policy, automatic account approval: a join request waits for the owner', async () => {
      if (!plc) return;
      await xrpcAuthPost('net.openfederation.admin.updateServerSettings', adminToken, { changes: { accountApproval: 'automatic' } });
      const did = await newCommunity({ joinPolicy: 'approval', visibility: 'private' });
      const code = (await xrpcAuthPost('net.openfederation.invite.create', owner.accessJwt, { community: did })).body.code;
      const handle = uniqueHandle('i403-j2');
      const res = await register(handle, code);
      expect(res.status).toBe(201);
      expect(res.body.status).toBe('approved');
      expect(res.body.community).toEqual({ did, status: 'pending' });
      const user = await userId(handle);
      expect(await isMember(did, user.did)).toBe(false);
      const requests = await query<{ status: string }>(
        'SELECT status FROM join_requests WHERE community_did = $1 AND user_did = $2', [did, user.did]);
      expect(requests.rows).toEqual([{ status: 'pending' }]);
    });

    it('a plain sign-up code is untouched: no community, no join', async () => {
      if (!plc) return;
      const code = (await xrpcAuthPost('net.openfederation.invite.create', adminToken, {})).body.code;
      const res = await register(uniqueHandle('i403-j3'), code);
      expect(res.status).toBe(201);
      expect(res.body.community).toBeUndefined();
    });

    it('a code for a community that was suspended since joins nothing, and sign-up still works', async () => {
      if (!plc) return;
      await xrpcAuthPost('net.openfederation.admin.updateServerSettings', adminToken, { changes: { accountApproval: 'automatic' } });
      const did = await newCommunity();
      const code = (await xrpcAuthPost('net.openfederation.invite.create', owner.accessJwt, { community: did })).body.code;
      expect((await xrpcAuthPost('net.openfederation.community.suspend', adminToken, { did, reason: 'test' })).status).toBe(200);
      const res = await register(uniqueHandle('i403-j4'), code);
      expect(res.status).toBe(201);
      expect(res.body.community).toEqual({ did, status: 'refused' });
      expect((await xrpcAuthPost('net.openfederation.invite.create', owner.accessJwt, { community: did })).status).toBe(403);
    });
  });

  describe('end to end with the importer', () => {
    it('Slack: imports the fixture with its image, re-runs create nothing, a deleted post stays deleted', async () => {
      if (!plc) return;
      const did = await newCommunity();
      const exp = readSlackExport(SLACK_FIXTURE);
      try {
        const plan = mapSlackExport(exp);
        const totals = await runImport(plan, newCheckpoint(did, exp.teamId, false, 'slack'), serverTransport(owner.accessJwt), { checkpointPath: checkpoint() });
        expect(totals).toMatchObject({ threads: { created: 2 }, posts: { created: 8 }, attachments: { uploaded: 1, skipped: 0 } });

        const list = await xrpcGet('net.openfederation.forum.listThreads', { community: did });
        expect(list.body.threads.map((t: { title: string }) => t.title).sort()).toEqual(['#general', '#patterns']);
        const general = list.body.threads.find((t: { title: string }) => t.title === '#general');
        const thread = await xrpcGet('net.openfederation.forum.getThread', { uri: general.uri });
        const posts = thread.body.posts;
        expect(posts).toHaveLength(7);
        expect(posts[2].parentUri).toBe(posts[1].uri);
        const photo = posts.find((p: { record: { embeds?: unknown[] } }) => p.record.embeds);
        expect(photo.record.embeds[0]).toMatchObject({ $type: 'blob', mimeType: 'image/png' });
        expect(photo.record.importedFrom).toMatchObject({ platform: 'slack', channelId: 'C0GENERAL1', attachmentCount: 4 });

        // Delete one, then run the whole import again with a new checkpoint.
        const rkey = postRkey('slack', 'C0GENERAL1', '1767603600.000100');
        expect((await xrpcAuthPost('net.openfederation.forum.deletePost', owner.accessJwt, { rkey, community: did })).status).toBe(200);
        const again = await runImport(plan, newCheckpoint(did, exp.teamId, false, 'slack'), serverTransport(owner.accessJwt), { checkpointPath: checkpoint() });
        expect(again).toMatchObject({ threads: { created: 0, existing: 2 }, posts: { created: 0, existing: 7, deleted: 1 } });
        expect((await query('SELECT 1 FROM records_index WHERE community_did = $1 AND rkey = $2', [did, rkey])).rows).toHaveLength(0);
      } finally {
        exp.tree.close();
      }
    });

    it('Discord with --media: images uploaded and linked; community invite codes from the importer', async () => {
      if (!plc) return;
      const did = await newCommunity();
      const plan = mapExport(readExportDir(DISCORD_MEDIA), { exportDir: DISCORD_MEDIA });
      const cp = newCheckpoint(did, '1000000000000000500', false);
      const path = checkpoint();
      const totals = await runImport(plan, cp, serverTransport(owner.accessJwt), { checkpointPath: path });
      expect(totals).toMatchObject({ posts: { created: 3 }, attachments: { uploaded: 6, skipped: 0 } });

      const rows = await createInvites(inviteesFor(plan, null), plan, cp, serverTransport(owner.accessJwt), { checkpointPath: path, community: did });
      expect(rows).toHaveLength(2);
      const stored = await query<{ community_did: string; created_by: string }>('SELECT community_did FROM invites WHERE code = ANY($1)', [rows.map((r) => r.code)]);
      expect(stored.rows.map((r) => r.community_did)).toEqual([did, did]);
    });
  });
});
