/**
 * Owner-side account deletion (#269): com.atproto.server.requestAccountDelete
 * + deleteAccount.
 *
 * Who may delete: an active account (the standard case), or a deactivated
 * copy whose DID now names another server (left behind by a move, or a move
 * here that was abandoned). Never a deactivated account the DID still names
 * here (reactivate first), nor a suspended or taken-down one.
 *
 * Proof: a user account gives its password and the code emailed by
 * requestAccountDelete; a pseudonym gives a short-lived JWT signed by its
 * owner key (lxm = com.atproto.server.deleteAccount).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { api, xrpcAuthPost, createTestUser, isPLCAvailable, uniqueHandle } from './helpers.js';
import { query } from '../../src/db/client.js';
import { runtimeSettings } from '../../src/settings/runtime-settings.js';
import { setEmailSenderForTests } from '../../src/email/email-service.js';
import {
  pseudonymElsewhere, openHere, proofFor, pointHere, userElsewhere, serviceAuthFor, createAccount, newHandle,
} from './migration-helpers.js';

const DELETE = 'com.atproto.server.deleteAccount';
const TEST_PASSWORD = 'TestPassword123!'; // createTestUser's password
const mails: { to: string; subject: string; html: string }[] = [];

function codeFor(email: string): string {
  const mail = [...mails].reverse().find((m) => m.to === email && /deletion/i.test(m.subject));
  const m = mail && />([A-Z2-7]{5}-[A-Z2-7]{5})</.exec(mail.html);
  if (!m) throw new Error(`no deletion code mailed to ${email}`);
  return m[1];
}
const del = (body: Record<string, unknown>, jwt?: string) => {
  const req = api.post(`/xrpc/${DELETE}`).send(body).set('Content-Type', 'application/json');
  return jwt ? req.set('Authorization', `Bearer ${jwt}`) : req;
};
const exists = async (did: string) => (await query('SELECT 1 FROM users WHERE did = $1', [did])).rows.length === 1;

describe('owner-side account deletion', () => {
  let plc = false;
  const saved = { accounts: runtimeSettings().migration.accounts, pseudonyms: runtimeSettings().migration.pseudonyms };

  beforeAll(async () => {
    plc = await isPLCAvailable();
    setEmailSenderForTests(async (to, subject, html) => { mails.push({ to, subject, html }); });
    runtimeSettings().migration.accounts = 'open';
    runtimeSettings().migration.pseudonyms = 'open';
  });
  afterAll(() => {
    setEmailSenderForTests(null);
    runtimeSettings().migration.accounts = saved.accounts;
    runtimeSettings().migration.pseudonyms = saved.pseudonyms;
  });
  beforeEach(() => { mails.length = 0; });

  describe('a user account', () => {
    it('deletes with password and the emailed code; wrong ones are refused; the code works once', async () => {
      if (!plc) return;
      const user = await createTestUser(uniqueHandle('del'));
      const email = (await query<{ email: string }>('SELECT email FROM users WHERE did = $1', [user.did])).rows[0].email;
      const password = TEST_PASSWORD;

      expect((await xrpcAuthPost('com.atproto.server.requestAccountDelete', user.accessJwt, {})).status).toBe(200);
      const code = codeFor(email);

      const wrongCode = await del({ did: user.did, password, token: 'AAAAA-AAAAA' });
      expect(wrongCode.status).toBe(400);
      expect(wrongCode.body.error).toBe('InvalidToken');
      const wrongPassword = await del({ did: user.did, password: 'Wrong-password-123!', token: code });
      expect(wrongPassword.status).toBe(401);
      expect(await exists(user.did)).toBe(true);

      const ok = await del({ did: user.did, password, token: code });
      expect(ok.status).toBe(200);
      expect(await exists(user.did)).toBe(false);
      expect((await del({ did: user.did, password, token: code })).status).toBe(400);
    });

    it('refuses a deactivated account whose DID still names this server', async () => {
      if (!plc) return;
      const user = await createTestUser(uniqueHandle('deld'));
      const email = (await query<{ email: string }>('SELECT email FROM users WHERE did = $1', [user.did])).rows[0].email;
      await xrpcAuthPost('com.atproto.server.requestAccountDelete', user.accessJwt, {});
      const code = codeFor(email);
      expect((await xrpcAuthPost('com.atproto.server.deactivateAccount', user.accessJwt, {})).status).toBe(200);
      const res = await del({ did: user.did, password: TEST_PASSWORD, token: code });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('AccountDeactivated');
      expect(await exists(user.did)).toBe(true);
    });

    it('deletes the deactivated copy of an account whose DID names another server', async () => {
      if (!plc) return;
      const u = await userElsewhere();
      const email = `${uniqueHandle('mvdel')}@test.local`;
      const password = 'Moved-account-pw-1!';
      const opened = await createAccount({ did: u.did, handle: newHandle(), email, password }, await serviceAuthFor(u));
      expect(opened.status).toBe(200);
      expect((await xrpcAuthPost('com.atproto.server.requestAccountDelete', opened.body.accessJwt, {})).status).toBe(200);
      const res = await del({ did: u.did, password, token: codeFor(email) });
      expect(res.status).toBe(200);
      expect(await exists(u.did)).toBe(false);
    });

    it('refuses a suspended account', async () => {
      if (!plc) return;
      const user = await createTestUser(uniqueHandle('dels'));
      const email = (await query<{ email: string }>('SELECT email FROM users WHERE did = $1', [user.did])).rows[0].email;
      await xrpcAuthPost('com.atproto.server.requestAccountDelete', user.accessJwt, {});
      const code = codeFor(email);
      await query(`UPDATE users SET status = 'suspended' WHERE did = $1`, [user.did]);
      const res = await del({ did: user.did, password: TEST_PASSWORD, token: code });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('AccountModerated');
      expect(await exists(user.did)).toBe(true);
    });
  });

  describe('a pseudonym', () => {
    it('deletes its copy here (DID elsewhere) with an owner-key proof', async () => {
      if (!plc) return;
      const p = await pseudonymElsewhere();
      await openHere(p);
      const res = await del({ did: p.did }, proofFor({ ...p, lxm: DELETE }));
      expect(res.status).toBe(200);
      expect(await exists(p.did)).toBe(false);
    });

    it('refuses a proof for another DID or another method, and no proof at all', async () => {
      if (!plc) return;
      const p = await pseudonymElsewhere();
      const other = await pseudonymElsewhere();
      await openHere(p);
      for (const [jwt, why] of [
        [proofFor({ ...other, lxm: DELETE }), 'another DID'],
        [proofFor({ ...p, lxm: 'com.atproto.server.createAccount' }), 'another method'],
        [undefined, 'no proof'],
      ] as const) {
        const res = await del({ did: p.did }, jwt);
        expect(res.status, why).toBe(401);
      }
      expect(await exists(p.did)).toBe(true);
    });

    it('refuses while deactivated with the DID pointing here; deletes once active', async () => {
      if (!plc) return;
      const p = await pseudonymElsewhere();
      const session = await openHere(p);
      await pointHere(p, session.accessJwt);
      const refused = await del({ did: p.did }, proofFor({ ...p, lxm: DELETE }));
      expect(refused.status).toBe(400);
      expect(refused.body.error).toBe('AccountDeactivated');
      expect((await xrpcAuthPost('com.atproto.server.activateAccount', session.accessJwt, {})).status).toBe(200);
      const ok = await del({ did: p.did }, proofFor({ ...p, lxm: DELETE }));
      expect(ok.status).toBe(200);
      expect(await exists(p.did)).toBe(false);
    });
  });

  describe('a community left behind by a move', () => {
    it('its owner on another PDS deletes it with service auth (community.delete)', async () => {
      if (!plc) return;
      const creator = await createTestUser(uniqueHandle('delc'));
      const created = await xrpcAuthPost('net.openfederation.community.create', creator.accessJwt, {
        handle: uniqueHandle('delc'), didMethod: 'plc', visibility: 'public', joinPolicy: 'open',
      });
      expect(created.status).toBe(201);
      // Ownership is by DID (#267): an owner whose account lives elsewhere, and a copy that moved away.
      const owner = await userElsewhere();
      await query(`UPDATE communities SET owner_did = $2, status = 'moved' WHERE did = $1`, [created.body.did, owner.did]);
      const jwt = await serviceAuthFor(owner, { lxm: 'net.openfederation.community.delete' });
      const res = await api.post('/xrpc/net.openfederation.community.delete')
        .set('Authorization', `Bearer ${jwt}`).send({ did: created.body.did });
      expect(res.status).toBe(200);
      expect((await query('SELECT 1 FROM communities WHERE did = $1', [created.body.did])).rows).toHaveLength(0);
    });
  });
});
