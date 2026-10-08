import { describe, it, expect, afterEach } from 'vitest';
import { xrpcPost, isPLCAvailable } from './helpers.js';
import { query } from '../../src/db/client.js';
import { setPlcClientForTests } from '../../src/identity/plc-client.js';
import { derivePseudonymKeys } from '../../packages/openfederation-pseudonym/src/keys.js';
import { preparePseudonym } from './pseudonym-test-kit.js';

afterEach(() => setPlcClientForTests(null));

describe('net.openfederation.pseudonym.createAccount', () => {
  it('creates an active, email-less, password-less pseudonym with no audit trace', async () => {
    if (!(await isPLCAvailable())) return;
    const { phrase, did, handle, token } = await preparePseudonym();
    const res = await xrpcPost('net.openfederation.pseudonym.createAccount', { did, token });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ did, handle, status: 'approved' });
    const row = await query<any>('SELECT id, email, password_hash, auth_type, pseudonym_owner_key FROM users WHERE did = $1', [did]);
    expect(row.rows[0]).toMatchObject({ email: null, password_hash: null, auth_type: 'pseudonym', pseudonym_owner_key: derivePseudonymKeys(phrase).ownerDidKey });
    const audit = await query(`SELECT 1 FROM audit_log WHERE actor_id = $1 OR target_id = $1 OR target_id = $2 OR meta::text LIKE $3`, [row.rows[0].id, did, `%${did}%`]);
    expect(audit.rows).toHaveLength(0);
  });

  it('refuses a spent token, a missing token, an unknown DID and a duplicate', async () => {
    if (!(await isPLCAvailable())) return;
    const a = await preparePseudonym();
    expect((await xrpcPost('net.openfederation.pseudonym.createAccount', { did: a.did, token: a.token })).status).toBe(201);
    expect((await xrpcPost('net.openfederation.pseudonym.createAccount', { did: a.did, token: a.token })).status).toBe(409);
    const b = await preparePseudonym();
    const spent = await xrpcPost('net.openfederation.pseudonym.createAccount', { did: b.did, token: a.token });
    expect(spent.status).toBe(400);
    expect(spent.body.error).toBe('TokenSpent');
    expect((await xrpcPost('net.openfederation.pseudonym.createAccount', { did: b.did })).body.error).toBe('InvalidToken');
    expect((await xrpcPost('net.openfederation.pseudonym.createAccount', { did: 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa', token: b.token })).status).toBe(400);
  });
});
