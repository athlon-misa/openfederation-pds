// tests/api/pseudonym-login.test.ts
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { xrpcPost, xrpcAuthPost, isPLCAvailable } from './helpers.js';
import { query } from '../../src/db/client.js';
import { config } from '../../src/config.js';
import { setPlcClientForTests } from '../../src/identity/plc-client.js';
import { derivePseudonymKeys, generatePseudonymPhrase, signText } from '../../packages/openfederation-pseudonym/src/keys.js';
import { buildLoginMessage } from '../../packages/openfederation-pseudonym/src/formats.js';
import { preparePseudonym } from './pseudonym-test-kit.js';

afterEach(() => setPlcClientForTests(null));

let plc = false;
let phrase: string;
let did: string;
let handle: string;
let bare: string;

beforeEach(async () => {
  plc = await isPLCAvailable();
  if (!plc) return;
  const p = await preparePseudonym();
  ({ phrase, did, handle } = p);
  bare = handle.slice(0, -config.handleSuffix.length);
  await xrpcPost('net.openfederation.pseudonym.createAccount', { did, token: p.token });
});

async function login(p: string) {
  const k = derivePseudonymKeys(p);
  const ch = await xrpcPost('net.openfederation.pseudonym.getLoginChallenge', { ownerKey: k.ownerDidKey });
  const signature = signText(k.ownerPrivateKey, buildLoginMessage({ serviceDid: ch.body.serviceDid, challenge: ch.body.challenge }));
  return { ch, signature, res: await xrpcPost('net.openfederation.pseudonym.createSession', { challengeId: ch.body.challengeId, signature }) };
}

describe('pseudonym phrase login', () => {
  it('logs in with only the phrase, and the session refreshes', async () => {
    if (!plc) return;
    const { res } = await login(phrase);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ did, handle: bare, active: true });
    expect(res.body.email).toBeUndefined();
    expect((await xrpcAuthPost('com.atproto.server.refreshSession', res.body.refreshJwt, {})).status).toBe(200);
  });

  it('does not reveal whether an owner key has an account', async () => {
    if (!plc) return;
    const a = await xrpcPost('net.openfederation.pseudonym.getLoginChallenge', { ownerKey: derivePseudonymKeys(generatePseudonymPhrase()).ownerDidKey });
    const b = await xrpcPost('net.openfederation.pseudonym.getLoginChallenge', { ownerKey: derivePseudonymKeys(phrase).ownerDidKey });
    expect(a.status).toBe(b.status);
    expect(Object.keys(a.body).sort()).toEqual(Object.keys(b.body).sort());
    const { res } = await login(generatePseudonymPhrase());
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Unauthorized', message: 'Invalid credentials' });
  });

  it('rejects a replayed challenge, an expired one, and a wrong key; used challenges are deleted', async () => {
    if (!plc) return;
    const first = await login(phrase);
    expect((await query('SELECT 1 FROM pseudonym_login_challenges WHERE id = $1', [first.ch.body.challengeId])).rows).toHaveLength(0);
    expect((await xrpcPost('net.openfederation.pseudonym.createSession', { challengeId: first.ch.body.challengeId, signature: first.signature })).status).toBe(401);

    const k = derivePseudonymKeys(phrase);
    const ch = await xrpcPost('net.openfederation.pseudonym.getLoginChallenge', { ownerKey: k.ownerDidKey });
    await query(`UPDATE pseudonym_login_challenges SET expires_at = NOW() - INTERVAL '1 second' WHERE id = $1`, [ch.body.challengeId]);
    const sig = signText(k.ownerPrivateKey, buildLoginMessage({ serviceDid: ch.body.serviceDid, challenge: ch.body.challenge }));
    expect((await xrpcPost('net.openfederation.pseudonym.createSession', { challengeId: ch.body.challengeId, signature: sig })).status).toBe(401);

    const ch2 = await xrpcPost('net.openfederation.pseudonym.getLoginChallenge', { ownerKey: k.ownerDidKey });
    const other = derivePseudonymKeys(generatePseudonymPhrase());
    const bad = signText(other.ownerPrivateKey, buildLoginMessage({ serviceDid: ch2.body.serviceDid, challenge: ch2.body.challenge }));
    expect((await xrpcPost('net.openfederation.pseudonym.createSession', { challengeId: ch2.body.challengeId, signature: bad })).status).toBe(401);
    expect((await xrpcPost('net.openfederation.pseudonym.createSession', { challengeId: 'not-a-uuid', signature: bad })).status).toBe(401);
  });

  it('password login on a pseudonym handle gets the generic 401 and writes no audit', async () => {
    if (!plc) return;
    const res = await xrpcPost('com.atproto.server.createSession', { identifier: bare, password: 'anything-at-all-1A!' });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Unauthorized', message: 'Invalid credentials' });
    for (const id of [bare, handle]) {
      expect((await query(`SELECT 1 FROM audit_log WHERE meta->>'identifier' = $1`, [id])).rows).toHaveLength(0);
    }
  });

  it('can write under EMAIL_VERIFICATION_POLICY=require-for-write', async () => {
    if (!plc) return;
    const original = config.emailVerification.policy;
    (config.emailVerification as any).policy = 'require-for-write';
    try {
      const { res } = await login(phrase);
      const write = await xrpcAuthPost('com.atproto.repo.createRecord', res.body.accessJwt, {
        repo: did, collection: 'app.bsky.feed.post',
        record: { $type: 'app.bsky.feed.post', text: 'hello', createdAt: new Date().toISOString() },
      });
      expect(write.status).toBe(200);
    } finally {
      (config.emailVerification as any).policy = original;
    }
  });
});
