import { describe, it, expect } from 'vitest';
import { api, xrpcGet, createTestUser, isPLCAvailable, uniqueHandle } from './helpers.js';
import { query } from '../../src/db/client.js';

describe('XRPC router', () => {
  it('answers 404 for names that exist on every JavaScript object', async () => {
    for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      const res = await xrpcGet(name);
      expect(res.status, name).toBe(404);
      expect(res.body.error).toBe('MethodNotFound');
    }
  });

  it('does not run a procedure on GET', async () => {
    if (!(await isPLCAvailable())) return;
    // A throwaway account: before the fix this GET really did deactivate it.
    const user = await createTestUser(uniqueHandle('router'));
    for (const nsid of ['com.atproto.server.deactivateAccount', 'com.atproto.server.requestEmailConfirmation', 'com.atproto.server.deleteSession']) {
      const res = await api.get(`/xrpc/${nsid}`).set('Authorization', `Bearer ${user.accessJwt}`);
      expect(res.status, nsid).toBe(405);
    }
    const row = await query<{ status: string }>('SELECT status FROM users WHERE did = $1', [user.did]);
    expect(row.rows[0].status).toBe('approved');
  });

  it('validates a query\'s parameters even when it is sent as a POST', async () => {
    // listAll declares limit as an integer with a maximum. Sent as a POST, the
    // declared parameters used to be checked against the (empty) body instead.
    const asGet = await api.get('/xrpc/net.openfederation.community.listAll?limit=99999');
    expect(asGet.status).toBe(400);
    const asPost = await api.post('/xrpc/net.openfederation.community.listAll?limit=99999').send({});
    expect(asPost.status).toBe(400);
  });
});
