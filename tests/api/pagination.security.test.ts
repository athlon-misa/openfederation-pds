/** Paging through a list returns every item exactly once. */
import { describe, it, expect, beforeAll } from 'vitest';
import { xrpcAuthPost, xrpcAuthGet, createTestUser, isPLCAvailable, uniqueHandle } from './helpers.js';
import { createNotification, listNotifications } from '../../src/notification/index.js';
import { query } from '../../src/db/client.js';

describe('pagination', () => {
  let plc: boolean;
  beforeAll(async () => { plc = await isPLCAvailable(); });

  it('listProposals pages through every proposal', async () => {
    if (!plc) return;
    const owner = await createTestUser(uniqueHandle('page-owner'));
    const created = await xrpcAuthPost('net.openfederation.community.create', owner.accessJwt, {
      handle: uniqueHandle('page'), didMethod: 'plc', visibility: 'public', joinPolicy: 'open',
    });
    const communityDid = created.body.did;
    const model = await xrpcAuthPost('net.openfederation.community.setGovernanceModel', owner.accessJwt, {
      communityDid, governanceModel: 'simple-majority',
      governanceConfig: { quorum: 2, voterRole: 'moderator', proposalTtlDays: 7, timelockHours: 0 },
    });
    expect(model.status).toBe(200);
    const made: string[] = [];
    for (let i = 0; i < 5; i++) {
      const p = await xrpcAuthPost('net.openfederation.community.createProposal', owner.accessJwt, {
        communityDid, targetCollection: 'net.openfederation.community.metadata', targetRkey: `page-${i}`,
        action: 'write', proposedRecord: { displayName: `p${i}` },
      });
      expect(p.status).toBe(200);
      made.push(p.body.rkey);
    }
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const params: Record<string, string> = { communityDid, limit: '2' };
      if (cursor) params.cursor = cursor;
      const res = await xrpcAuthGet('net.openfederation.community.listProposals', owner.accessJwt, params);
      expect(res.status).toBe(200);
      seen.push(...res.body.proposals.map((p: any) => p.rkey));
      cursor = res.body.cursor;
      if (!cursor) break;
    }
    expect(seen.sort()).toEqual([...made].sort());
  });

  it('notifications page through every notification, newest first', async () => {
    const did = `did:plc:pagetest${Date.now()}`;
    const auth = { did } as any;
    for (let i = 0; i < 7; i++) {
      await createNotification(did, 'test', { n: i });
      // distinct timestamps, in order
      await query(`UPDATE notifications SET created_at = CURRENT_TIMESTAMP - ($2::int * INTERVAL '1 minute')
                   WHERE recipient_did = $1 AND payload->>'n' = $3`, [did, 7 - i, String(i)]);
    }
    const seen: number[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const res = await listNotifications(auth, { limit: 3, cursor });
      seen.push(...(res.notifications as any[]).map((n) => n.payload.n));
      cursor = res.cursor;
      if (!cursor) break;
    }
    expect(seen).toEqual([6, 5, 4, 3, 2, 1, 0]);
  });

  it('a malformed notification cursor is a bad request, not a server error', async () => {
    if (!plc) return;
    const user = await createTestUser(uniqueHandle('page-notif'));
    const res = await xrpcAuthGet('net.openfederation.notification.list', user.accessJwt, { cursor: 'not-a-cursor' });
    expect(res.status).toBe(400);
  });
});
