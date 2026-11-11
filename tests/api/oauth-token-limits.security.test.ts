/**
 * What an OAuth token may do:
 *  - it is for third-party apps, so it never carries the account's PDS roles
 *    (an admin who signs in to an app must not hand that app admin powers);
 *  - like every other credential, it is refused for an account that is not
 *    approved (pending sign-up, rejected).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { api, createTestUser, getAdminToken, isPLCAvailable, uniqueHandle } from './helpers.js';
import { query } from '../../src/db/client.js';
import { setOAuthVerifier } from '../../src/auth/verification.js';
import { invalidateAuthContext } from '../../src/auth/auth-context-cache.js';

const tokens = new Map<string, string>();
const asOAuth = (did: string) => {
  const t = `oauth-test-${did}`;
  tokens.set(t, did);
  return { Authorization: `DPoP ${t}`, DPoP: 'proof' };
};

describe('OAuth token limits', () => {
  let plc = false;
  let adminDid: string;
  let pending: { did: string; accessJwt: string };

  beforeAll(async () => {
    plc = await isPLCAvailable();
    if (!plc) return;
    setOAuthVerifier({
      authenticateRequest: async (_m: string, _u: URL, headers: Record<string, unknown>) => {
        const t = String(headers.authorization ?? '').replace(/^DPoP /, '');
        const sub = tokens.get(t);
        if (!sub) throw new Error('bad token');
        return { sub };
      },
    } as never);
    await getAdminToken();
    adminDid = (await query<{ did: string }>(
      `SELECT u.did FROM users u JOIN user_roles r ON r.user_id = u.id WHERE r.role = 'admin' AND u.did LIKE 'did:%' LIMIT 1`)).rows[0].did;
    pending = await createTestUser(uniqueHandle('oauthpend'));
    await query(`UPDATE users SET status = 'pending' WHERE did = $1`, [pending.did]);
  });

  afterAll(async () => {
    setOAuthVerifier(null);
    if (pending) await query(`UPDATE users SET status = 'approved' WHERE did = $1`, [pending.did]);
  });

  it('an admin signed in through OAuth has no admin powers', async () => {
    if (!plc) return;
    invalidateAuthContext(adminDid);
    const res = await api.get('/xrpc/net.openfederation.account.list').set(asOAuth(adminDid));
    expect(res.status).toBe(403);
    const session = await api.get('/xrpc/com.atproto.server.getSession').set(asOAuth(adminDid));
    expect(session.status).toBe(200);
  });

  it('the same admin keeps admin powers on a direct session', async () => {
    if (!plc) return;
    const res = await api.get('/xrpc/net.openfederation.account.list').set('Authorization', `Bearer ${await getAdminToken()}`);
    expect(res.status).toBe(200);
  });

  it('refuses an OAuth token for an account that is still pending', async () => {
    if (!plc) return;
    invalidateAuthContext(pending.did);
    const res = await api.get('/xrpc/com.atproto.server.getSession').set(asOAuth(pending.did));
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('AccountNotApproved');
  });

  it('refuses an OAuth token for a rejected account', async () => {
    if (!plc) return;
    await query(`UPDATE users SET status = 'rejected' WHERE did = $1`, [pending.did]);
    invalidateAuthContext(pending.did);
    const res = await api.post('/xrpc/com.atproto.repo.createRecord').set(asOAuth(pending.did))
      .send({ repo: pending.did, collection: 'app.bsky.feed.post', record: { $type: 'app.bsky.feed.post', text: 'x', createdAt: new Date().toISOString() } });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('AccountNotApproved');
  });
});
