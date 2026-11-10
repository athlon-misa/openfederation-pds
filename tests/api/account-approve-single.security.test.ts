/** One approve or reject request acts on one account. */
import { describe, it, expect, beforeAll } from 'vitest';
import { xrpcPost, xrpcAuthPost, getAdminToken, isPLCAvailable, uniqueHandle } from './helpers.js';
import { query } from '../../src/db/client.js';

async function pendingUser(adminToken: string): Promise<{ id: string; handle: string }> {
  const invite = await xrpcAuthPost('net.openfederation.invite.create', adminToken, { maxUses: 1 });
  const handle = uniqueHandle('pend');
  const res = await xrpcPost('net.openfederation.account.register', {
    handle, email: `${handle}@test.local`, password: 'TestPassword123!', inviteCode: invite.body.code,
  });
  return { id: res.body.userId || res.body.id, handle };
}
const statusOf = async (id: string) =>
  (await query<{ status: string }>('SELECT status FROM users WHERE id = $1', [id])).rows[0]?.status;

describe('account approve / reject', () => {
  let plc: boolean;
  let adminToken: string;
  beforeAll(async () => { plc = await isPLCAvailable(); adminToken = await getAdminToken(); });

  it('identifiers naming two different accounts approve neither', async () => {
    if (!plc) return;
    const a = await pendingUser(adminToken);
    const b = await pendingUser(adminToken);
    if ((await statusOf(a.id)) !== 'pending') return; // instance auto-approves; nothing to test
    const res = await xrpcAuthPost('net.openfederation.account.approve', adminToken, { userId: a.id, handle: b.handle });
    expect(res.status).toBe(404);
    expect(await statusOf(a.id)).toBe('pending');
    expect(await statusOf(b.id)).toBe('pending');
  });

  it('identifiers naming the same account still work', async () => {
    if (!plc) return;
    const a = await pendingUser(adminToken);
    if ((await statusOf(a.id)) !== 'pending') return;
    const res = await xrpcAuthPost('net.openfederation.account.approve', adminToken, { userId: a.id, handle: a.handle });
    expect(res.status).toBe(200);
    expect(await statusOf(a.id)).toBe('approved');
  });
});
