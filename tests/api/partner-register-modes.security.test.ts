/**
 * A partner key travels in browser code, so having it proves nothing. What a
 * registration made with it is worth depends on what else is presented:
 *
 *  - a ticket signed by the partner's own backend: an approved account and a
 *    session, as before;
 *  - nothing else: an account that exists but cannot be used until its email
 *    address is verified.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Secp256k1Keypair } from '@atproto/crypto';
import { api, getAdminToken, isPLCAvailable, uniqueHandle, xrpcAuthPost, xrpcPost, hrefContaining } from './helpers.js';
import { query } from '../../src/db/client.js';
import { config } from '../../src/config.js';
import { setEmailSenderForTests } from '../../src/email/email-service.js';
import { createPartnerTicket, generatePartnerTicketKey } from '../../packages/openfederation-sdk/src/partner-ticket.js';

const ORIGIN = 'https://partner.test';
const inbox: Array<{ to: string; subject: string; html: string }> = [];

async function partnerKey(extra: Record<string, unknown> = {}): Promise<{ id: string; key: string }> {
  const created = await xrpcAuthPost('net.openfederation.partner.createKey', await getAdminToken(), {
    name: uniqueHandle('partner'), partnerName: 'Modes Test', allowedOrigins: [ORIGIN],
    rateLimitPerHour: 1000, permissions: ['register'], ...extra,
  });
  expect(created.status).toBe(201);
  await query("UPDATE partner_keys SET verification_state = 'verified' WHERE id = $1", [created.body.id]);
  return { id: created.body.id, key: created.body.key };
}

function register(key: string, body: Record<string, unknown>) {
  return api.post('/xrpc/net.openfederation.partner.register')
    .set('X-Partner-Key', key).set('Origin', ORIGIN).send(body);
}
const account = () => {
  const handle = uniqueHandle('pmode');
  return { handle, email: `${handle}@test.local`, password: 'TestPassword123!' };
};

describe('partner registration modes', () => {
  let plc: boolean;
  beforeAll(async () => {
    plc = await isPLCAvailable();
    setEmailSenderForTests(async (to, subject, html) => { inbox.push({ to, subject, html }); });
  });
  afterAll(() => setEmailSenderForTests(null));

  describe('a key with no ticket key (browser-only partner)', () => {
    it('creates an account that has no session and is not approved', async () => {
      if (!plc) return;
      const { key } = await partnerKey();
      const who = account();
      const res = await register(key, who);
      expect(res.status).toBe(201);
      expect(res.body.status).toBe('pending');
      expect(res.body.emailVerificationRequired).toBe(true);
      expect(res.body.accessJwt).toBeUndefined();
      expect(res.body.refreshJwt).toBeUndefined();

      const login = await xrpcPost('com.atproto.server.createSession', { identifier: who.handle, password: who.password });
      expect(login.status).not.toBe(200);
    });

    it('approves the account once its email address is verified', async () => {
      if (!plc) return;
      const { key } = await partnerKey();
      const who = account();
      expect((await register(key, who)).status).toBe(201);

      let link: URL | undefined;
      for (let i = 0; i < 50 && !link; i++) {
        const mail = [...inbox].reverse().find((m) => m.to === who.email && m.subject.includes('Verify'));
        const found = mail ? hrefContaining(mail.html, '/verify-email?') : undefined;
        if (found) link = new URL(found);
        else await new Promise((r) => setTimeout(r, 100));
      }
      expect(link, 'verification email').toBeTruthy();
      const opened = await api.get(`${link!.pathname}${link!.search}`);
      expect(opened.status).toBe(200);

      const login = await xrpcPost('com.atproto.server.createSession', { identifier: who.handle, password: who.password });
      expect(login.status).toBe(200);
    });
  });

  describe('a key with a ticket key (partner with a backend)', () => {
    let key: string;
    let keyId: string;
    let ticketKey: Awaited<ReturnType<typeof generatePartnerTicketKey>>;
    const ticketFor = (who: { handle: string; email: string }, over: Record<string, unknown> = {}) => createPartnerTicket({
      partnerKeyId: keyId, privateKeyHex: ticketKey.privateKeyHex, audience: config.pds.serviceDid,
      handle: who.handle, email: who.email, ...over,
    });

    beforeAll(async () => {
      if (!plc) return;
      ticketKey = generatePartnerTicketKey();
      const created = await partnerKey({ ticketPublicKey: ticketKey.publicKey });
      key = created.key;
      keyId = created.id;
    });

    it('refuses a registration with the key alone', async () => {
      if (!plc) return;
      const res = await register(key, account());
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('TicketRequired');
    });

    it('with a valid ticket, creates an approved account and signs it in', async () => {
      if (!plc) return;
      const who = account();
      const res = await register(key, { ...who, ticket: ticketFor(who) });
      expect(res.status).toBe(201);
      expect(res.body.status).toBe('approved');
      expect(typeof res.body.accessJwt).toBe('string');
    });

    it('refuses a ticket used a second time', async () => {
      if (!plc) return;
      const who = account();
      const ticket = ticketFor(who);
      expect((await register(key, { ...who, ticket })).status).toBe(201);
      const again = await register(key, { ...account(), ticket });
      expect(again.status).toBe(401);
    });

    it('refuses a ticket issued for a different account', async () => {
      if (!plc) return;
      const res = await register(key, { ...account(), ticket: ticketFor(account()) });
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('TicketInvalid');
    });

    it('refuses a ticket signed by some other key, an expired one, or one for another server', async () => {
      if (!plc) return;
      const stranger = generatePartnerTicketKey();
      const who = account();
      const forged = createPartnerTicket({
        partnerKeyId: keyId, privateKeyHex: stranger.privateKeyHex, audience: config.pds.serviceDid, ...who,
      });
      expect((await register(key, { ...who, ticket: forged })).status).toBe(401);
      expect((await register(key, { ...who, ticket: ticketFor(who, { ttlSeconds: -60 }) })).status).toBe(401);
      expect((await register(key, { ...who, ticket: ticketFor(who, { audience: 'did:web:other.example' }) })).status).toBe(401);
      expect((await register(key, { ...who, ticket: ticketFor(who, { ttlSeconds: 86400 }) })).status).toBe(401);
    });
  });

  it('the ticket key the SDK generates is one the server recognises', async () => {
    const generated = generatePartnerTicketKey();
    // Same encoding @atproto/crypto produces for the same private key.
    const viaAtproto = await Secp256k1Keypair.import(Buffer.from(generated.privateKeyHex, 'hex'));
    expect(generated.publicKey).toBe(viaAtproto.did());
  });

  it('rejects a ticket key that is not a did:key', async () => {
    const res = await xrpcAuthPost('net.openfederation.partner.createKey', await getAdminToken(), {
      name: uniqueHandle('partner'), partnerName: 'Bad', allowedOrigins: [ORIGIN], ticketPublicKey: 'not-a-key',
    });
    expect(res.status).toBe(400);
  });
});
