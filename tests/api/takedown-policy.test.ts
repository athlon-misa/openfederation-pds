/**
 * Takedown policy (docs/FAIR-USE.md):
 *  - standard takedown: hidden at once; the owner gets a private export link
 *    and 30 days; a reminder 7 days before; then the data is deleted;
 *  - hard takedown (illegal content): hidden, no owner export, kept 90 days
 *    (legal hold), then deleted;
 *  - an admin can reverse either during the window.
 * Same rules for accounts and communities.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  api, xrpcAuthPost, xrpcAuthGet, createTestUser, getAdminToken, isPLCAvailable, uniqueHandle,
} from './helpers.js';
import { query } from '../../src/db/client.js';
import { setEmailSenderForTests } from '../../src/email/email-service.js';
import { sweepTakedowns, EXPORT_WINDOW_DAYS, LEGAL_HOLD_DAYS } from '../../src/moderation/takedown.js';

type Mail = { to: string; subject: string; html: string };
const mails: Mail[] = [];
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
const DAY = 86_400_000;
// Collect a binary response (a CAR file) into a Buffer.
const binary = (res: any, done: (err: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => done(null, Buffer.concat(chunks)));
};

function linkIn(mail: Mail): string {
  const m = /href="(https?:\/\/[^"]+\/takedown-export\/[^"]+)"/.exec(mail.html);
  if (!m) throw new Error('no export link in mail');
  return new URL(m[1]).pathname;
}

describe('takedown policy', () => {
  let plc = false;
  let admin: string;

  beforeAll(async () => {
    plc = await isPLCAvailable();
    setEmailSenderForTests(async (to, subject, html) => { mails.push({ to, subject, html }); });
    if (plc) admin = await getAdminToken();
  });
  afterAll(() => setEmailSenderForTests(null));
  beforeEach(() => { mails.length = 0; });

  async function newCommunity() {
    const owner = await createTestUser(uniqueHandle('tdp-owner'));
    const created = await xrpcAuthPost('net.openfederation.community.create', owner.accessJwt, {
      handle: uniqueHandle('tdp'), didMethod: 'plc', visibility: 'public', joinPolicy: 'open',
    });
    expect(created.status).toBe(201);
    return { owner, did: created.body.did as string };
  }

  describe('standard takedown of a community', () => {
    it('needs no prior export, sets a 30-day deadline and emails the owner a working export link', async () => {
      if (!plc) return;
      const { did } = await newCommunity();
      const res = await xrpcAuthPost('net.openfederation.admin.takedown', admin, { did, tier: 'standard', reason: 'Spam, rule 3' });
      expect(res.status).toBe(200);
      const days = (new Date(res.body.deleteAfter).getTime() - Date.now()) / DAY;
      expect(Math.round(days)).toBe(EXPORT_WINDOW_DAYS);

      const notice = mails.find((m) => m.subject.includes('taken down'));
      expect(notice).toBeTruthy();
      expect(notice!.html).toContain('Spam, rule 3');
      const link = linkIn(notice!);

      // Hidden from the public at once.
      expect((await api.get('/xrpc/com.atproto.repo.describeRepo').query({ repo: did })).status).toBe(400);

      // The link serves the repository as a CAR file, and the blob list.
      const car = await api.get(link).buffer(true).parse(binary);
      expect(car.status).toBe(200);
      expect(car.headers['content-type']).toMatch(/application\/vnd\.ipld\.car/);
      expect(car.body.length).toBeGreaterThan(100);
      const blobs = await api.get(`${link}/blobs`);
      expect(blobs.status).toBe(200);
      expect(Array.isArray(blobs.body.cids)).toBe(true);

      // First export: one confirmation email with the deletion date; not again.
      expect(mails.filter((m) => m.subject.includes('export')).length).toBe(1);
      await api.get(link).buffer(true);
      expect(mails.filter((m) => m.subject.includes('export')).length).toBe(1);
    });

    it('the owner can still export while it is taken down', async () => {
      if (!plc) return;
      const { owner, did } = await newCommunity();
      await xrpcAuthPost('net.openfederation.admin.takedown', admin, { did, tier: 'standard', reason: 'r' });
      const res = await xrpcAuthGet('net.openfederation.community.export', owner.accessJwt, { did });
      expect(res.status).toBe(200);
    });

    it('the old community.takedown endpoint no longer requires a prior export', async () => {
      if (!plc) return;
      const { did } = await newCommunity();
      const res = await xrpcAuthPost('net.openfederation.community.takedown', admin, { did, reason: 'r' });
      expect(res.status).toBe(200);
    });
  });

  describe('hard takedown', () => {
    it('gives the owner no export: no link, and community.export is refused; an admin can still export', async () => {
      if (!plc) return;
      const { owner, did } = await newCommunity();
      const res = await xrpcAuthPost('net.openfederation.admin.takedown', admin, { did, tier: 'hard', reason: 'Illegal content' });
      expect(res.status).toBe(200);
      expect(res.body.exportUrl).toBeUndefined();
      const days = (new Date(res.body.deleteAfter).getTime() - Date.now()) / DAY;
      expect(Math.round(days)).toBe(LEGAL_HOLD_DAYS);
      for (const m of mails) expect(m.html).not.toMatch(/takedown-export/);

      const own = await xrpcAuthGet('net.openfederation.community.export', owner.accessJwt, { did });
      expect(own.status).toBe(403);
      const adm = await xrpcAuthGet('net.openfederation.community.export', admin, { did });
      expect(adm.status).toBe(200);
    });

    it('escalating a standard takedown to hard kills the export link at once', async () => {
      if (!plc) return;
      const { did } = await newCommunity();
      await xrpcAuthPost('net.openfederation.admin.takedown', admin, { did, tier: 'standard', reason: 'r' });
      const link = linkIn(mails.find((m) => /takedown-export/.test(m.html))!);
      expect((await api.get(link).buffer(true).parse(binary)).status).toBe(200);
      const res = await xrpcAuthPost('net.openfederation.admin.takedown', admin, { did, tier: 'hard', reason: 'Illegal content found' });
      expect(res.status).toBe(200);
      expect((await api.get(link)).status).toBe(404);
    });
  });

  describe('reversal', () => {
    it('restores the community and kills the export link', async () => {
      if (!plc) return;
      const { did } = await newCommunity();
      await xrpcAuthPost('net.openfederation.admin.takedown', admin, { did, tier: 'standard', reason: 'r' });
      const link = linkIn(mails.find((m) => /takedown-export/.test(m.html))!);
      const rev = await xrpcAuthPost('net.openfederation.admin.reverseTakedown', admin, { did });
      expect(rev.status).toBe(200);
      const row = (await query<{ status: string }>('SELECT status FROM communities WHERE did = $1', [did])).rows[0];
      expect(row.status).toBe('active');
      expect((await api.get(link)).status).toBe(404);
    });
  });

  describe('accounts', () => {
    it('a standard account takedown emails the user a link that serves their repository and blobs', async () => {
      if (!plc) return;
      const user = await createTestUser(uniqueHandle('tdp-user'));
      const up = await api.post('/xrpc/com.atproto.repo.uploadBlob')
        .set('Authorization', `Bearer ${user.accessJwt}`).set('Content-Type', 'image/png').send(PNG);
      const cid = up.body.blob.ref.$link;
      const res = await xrpcAuthPost('net.openfederation.admin.takedown', admin, { did: user.did, tier: 'standard', reason: 'Harassment' });
      expect(res.status).toBe(200);
      const link = linkIn(mails.find((m) => /takedown-export/.test(m.html))!);
      expect((await api.get(link).buffer(true)).status).toBe(200);
      const blobs = await api.get(`${link}/blobs`);
      expect(blobs.body.cids).toContain(cid);
      const blob = await api.get(`${link}/blob/${cid}`).buffer(true);
      expect(blob.status).toBe(200);
      expect(Buffer.compare(blob.body, PNG)).toBe(0);
    });

    it('updateSubjectStatus takedown no longer requires a prior export', async () => {
      if (!plc) return;
      const user = await createTestUser(uniqueHandle('tdp-usr2'));
      const res = await xrpcAuthPost('com.atproto.admin.updateSubjectStatus', admin, {
        subject: { $type: 'com.atproto.admin.defs#repoRef', did: user.did }, takedown: { applied: true, ref: 'r' },
      });
      expect(res.status).toBe(200);
    });
  });

  describe('the daily sweep', () => {
    it('reminds an owner who has not exported 7 days before, once', async () => {
      if (!plc) return;
      const { did } = await newCommunity();
      await xrpcAuthPost('net.openfederation.admin.takedown', admin, { did, tier: 'standard', reason: 'r' });
      await query(`UPDATE communities SET takedown_delete_after = NOW() + INTERVAL '6 days' WHERE did = $1`, [did]);
      mails.length = 0;
      await sweepTakedowns();
      expect(mails.filter((m) => m.subject.toLowerCase().includes('reminder')).length).toBe(1);
      await sweepTakedowns();
      expect(mails.filter((m) => m.subject.toLowerCase().includes('reminder')).length).toBe(1);
    });

    it('deletes a community and an account once their deadline has passed', async () => {
      if (!plc) return;
      const { did } = await newCommunity();
      const user = await createTestUser(uniqueHandle('tdp-del'));
      await xrpcAuthPost('net.openfederation.admin.takedown', admin, { did, tier: 'standard', reason: 'r' });
      await xrpcAuthPost('net.openfederation.admin.takedown', admin, { did: user.did, tier: 'hard', reason: 'r' });
      await query(`UPDATE communities SET takedown_delete_after = NOW() - INTERVAL '1 minute' WHERE did = $1`, [did]);
      await query(`UPDATE users SET takedown_delete_after = NOW() - INTERVAL '1 minute' WHERE did = $1`, [user.did]);
      await sweepTakedowns();
      expect((await query('SELECT 1 FROM communities WHERE did = $1', [did])).rows).toHaveLength(0);
      expect((await query('SELECT 1 FROM records_index WHERE community_did = $1', [did])).rows).toHaveLength(0);
      expect((await query('SELECT 1 FROM users WHERE did = $1', [user.did])).rows).toHaveLength(0);
    });

    it('leaves a taken-down repository alone before its deadline', async () => {
      if (!plc) return;
      const { did } = await newCommunity();
      await xrpcAuthPost('net.openfederation.admin.takedown', admin, { did, tier: 'standard', reason: 'r' });
      await sweepTakedowns();
      expect((await query('SELECT 1 FROM communities WHERE did = $1', [did])).rows).toHaveLength(1);
    });
  });
});
