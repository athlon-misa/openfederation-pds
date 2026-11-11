/** listPending answered 500 whenever a sign-up was pending: rows used column names, not the lexicon's. */
import { describe, it, expect } from 'vitest';
import { xrpcPost, xrpcAuthGet, getAdminToken, uniqueHandle } from './helpers.js';
import { query } from '../../src/db/client.js';

describe('account.listPending', () => {
  it('lists a pending sign-up with its lexicon fields', async () => {
    const handle = uniqueHandle('pend');
    const invite = await (await import('./helpers.js')).xrpcAuthPost('net.openfederation.invite.create', await getAdminToken(), { maxUses: 1 });
    const reg = await xrpcPost('net.openfederation.account.register', {
      handle, email: `${handle}@test.local`, password: 'Pending-pass-123!', inviteCode: invite.body.code,
    });
    expect(reg.status).toBeLessThan(300);
    await query(`UPDATE users SET status = 'pending' WHERE handle LIKE $1`, [`${handle}%`]);
    // Oldest first, 100 per page: page until the new sign-up shows up.
    let row: Record<string, unknown> | undefined;
    for (let offset = 0; !row; offset += 100) {
      const res = await xrpcAuthGet('net.openfederation.account.listPending', await getAdminToken(), { limit: '100', offset: String(offset) });
      expect(res.status).toBe(200);
      if (res.body.users.length === 0) break;
      row = res.body.users.find((u: { handle: string }) => u.handle.startsWith(handle));
    }
    expect(row).toMatchObject({ id: expect.any(String), email: `${handle}@test.local`, createdAt: expect.any(String) });
    expect(row!.created_at).toBeUndefined();
  });
});
