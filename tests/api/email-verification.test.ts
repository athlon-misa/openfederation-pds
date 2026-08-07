/**
 * Email verification end to end (#83, part B).
 *
 * The chain under test: registration issues a token and emails a link → the
 * link (or the XRPC confirm) redeems it exactly once → the account's state
 * flips and getSession says so → the policy knob decides what unverified
 * blocks. The raw token exists only inside the captured email, exactly as it
 * would for a real user — nothing here reads tokens out of the database.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  api, xrpcPost, xrpcAuthGet, xrpcAuthPost,
  createTestUser, isPLCAvailable, uniqueHandle,
} from './helpers.js';
import { setEmailSenderForTests } from '../../src/email/email-service.js';
import { config } from '../../src/config.js';
import { query } from '../../src/db/client.js';

type Captured = { to: string; subject: string; html: string };
const inbox: Captured[] = [];

/** The verification link, as a user would see it: out of the email body. */
function linkFor(email: string): { token: string; email: string } | null {
  const mail = [...inbox].reverse().find(m => m.to === email && m.subject.includes('Verify'));
  if (!mail) return null;
  const m = mail.html.match(/\/verify-email\?token=([^&"]+)&amp;email=([^&"]+)|\/verify-email\?token=([^&"]+)&email=([^&"]+)/);
  if (!m) return null;
  const token = decodeURIComponent(m[1] ?? m[3]);
  const addr = decodeURIComponent(m[2] ?? m[4]);
  return { token, email: addr };
}

async function waitForMail(email: string, tries = 50): Promise<{ token: string; email: string }> {
  // Registration fires the verification send off the response path, so the
  // capture can trail the 201 by a beat.
  for (let i = 0; i < tries; i++) {
    const link = linkFor(email);
    if (link) return link;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`no verification email captured for ${email}`);
}

describe('email verification (#83)', () => {
  let plcAvailable: boolean;
  const originalPolicy = config.emailVerification.policy;

  beforeAll(async () => {
    plcAvailable = await isPLCAvailable();
    setEmailSenderForTests(async (to, subject, html) => { inbox.push({ to, subject, html }); });
  });
  afterAll(() => {
    setEmailSenderForTests(null);
    config.emailVerification.policy = originalPolicy;
  });

  describe('the token round trip', () => {
    let user: { accessJwt: string; did: string; handle: string };
    let email: string;

    beforeAll(async () => {
      if (!plcAvailable) return;
      const handle = uniqueHandle('verify');
      user = await createTestUser(handle);
      email = `${handle}@test.local`;
    });

    it('registration sends a verification link', async () => {
      if (!plcAvailable) return;
      const link = await waitForMail(email);
      expect(link.email).toBe(email);
      expect(link.token.length).toBeGreaterThan(40);
    });

    it('getSession reports unverified until the link is used', async () => {
      if (!plcAvailable) return;
      const before = await xrpcAuthPost('com.atproto.server.getSession', user.accessJwt, {});
      expect(before.status).toBe(200);
      expect(before.body.emailConfirmed).toBe(false);
    });

    it('the emailed link verifies, logged out, in a browser', async () => {
      if (!plcAvailable) return;
      const link = await waitForMail(email);
      const res = await api.get(`/verify-email?token=${encodeURIComponent(link.token)}&email=${encodeURIComponent(link.email)}`);
      expect(res.status).toBe(200);
      expect(res.text).toContain('Email verified');

      const after = await xrpcAuthPost('com.atproto.server.getSession', user.accessJwt, {});
      expect(after.body.emailConfirmed).toBe(true);
    });

    it('burns the token on redemption — the same link fails the second time', async () => {
      if (!plcAvailable) return;
      const link = await waitForMail(email);
      const res = await xrpcPost('com.atproto.server.confirmEmail', { email: link.email, token: link.token });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('InvalidToken');
    });

    it('resend is idempotent once verified', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthPost('com.atproto.server.requestEmailConfirmation', user.accessJwt, {});
      expect(res.status).toBe(200);
      expect(res.body.alreadyVerified).toBe(true);
    });
  });

  describe('tokens that must not verify', () => {
    let user: { accessJwt: string; did: string; handle: string };
    let email: string;

    beforeAll(async () => {
      if (!plcAvailable) return;
      const handle = uniqueHandle('badtok');
      user = await createTestUser(handle);
      email = `${handle}@test.local`;
      await waitForMail(email);
    });

    it('rejects a token presented with the wrong email', async () => {
      if (!plcAvailable) return;
      const link = await waitForMail(email);
      const res = await xrpcPost('com.atproto.server.confirmEmail', { email: 'other@test.local', token: link.token });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('InvalidEmail');

      // A redemption attempt is a use: the failed try burned the token, so
      // even the RIGHT address cannot redeem it now. A token that leaked far
      // enough to be tried is a token that should die.
      const retry = await xrpcPost('com.atproto.server.confirmEmail', { email, token: link.token });
      expect(retry.status).toBe(400);
      expect(retry.body.error).toBe('InvalidToken');
    });

    it('rejects an expired token as expired, distinctly', async () => {
      if (!plcAvailable) return;
      // Resend to mint a fresh token (the wrong-email attempt burned the last).
      const resend = await xrpcAuthPost('com.atproto.server.requestEmailConfirmation', user.accessJwt, {});
      expect(resend.status).toBe(200);
      const link = await waitForMail(email);
      await query(
        `UPDATE email_verification_tokens SET expires_at = NOW() - INTERVAL '1 minute'
         WHERE user_id = (SELECT id FROM users WHERE handle = $1)`,
        [user.handle],
      );
      const res = await xrpcPost('com.atproto.server.confirmEmail', { email, token: link.token });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('ExpiredToken');
    });

    it('refuses to confirm another account\'s email from your session', async () => {
      if (!plcAvailable) return;
      const other = await createTestUser(uniqueHandle('mallory'));
      const link = await waitForMail(email).catch(() => null);
      const res = await xrpcAuthPost('com.atproto.server.confirmEmail', other.accessJwt, {
        email, token: link?.token ?? 'x'.repeat(64),
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('InvalidEmail');
    });

    it('resend mints a fresh link and invalidates the old one', async () => {
      if (!plcAvailable) return;
      const first = await xrpcAuthPost('com.atproto.server.requestEmailConfirmation', user.accessJwt, {});
      expect(first.status).toBe(200);
      const oldLink = await waitForMail(email);
      const second = await xrpcAuthPost('com.atproto.server.requestEmailConfirmation', user.accessJwt, {});
      expect(second.status).toBe(200);
      // Wait until a *different* token shows up as the newest capture.
      let newLink = await waitForMail(email);
      for (let i = 0; i < 50 && newLink.token === oldLink.token; i++) {
        await new Promise(r => setTimeout(r, 100));
        newLink = await waitForMail(email);
      }
      expect(newLink.token).not.toBe(oldLink.token);

      const stale = await xrpcPost('com.atproto.server.confirmEmail', { email, token: oldLink.token });
      expect(stale.status).toBe(400);
      expect(stale.body.error).toBe('InvalidToken');

      const fresh = await xrpcPost('com.atproto.server.confirmEmail', { email, token: newLink.token });
      expect(fresh.status).toBe(200);
      expect(fresh.body.verified).toBe(true);
    });
  });

  describe('the policy knob', () => {
    let unverified: { accessJwt: string; did: string; handle: string };
    let password: string;

    beforeAll(async () => {
      if (!plcAvailable) return;
      const handle = uniqueHandle('gated');
      unverified = await createTestUser(handle);
      // createTestUser's password convention — needed to attempt re-login.
      password = 'TestPassword123!';
    });

    afterAll(() => { config.emailVerification.policy = originalPolicy; });

    // The probe: community.join with a nonexistent DID. Input validates (so
    // the router does not 400 first), requireApprovedUser runs before the
    // community lookup — under the gating policy the guard answers, under
    // advisory the lookup does.
    const probe = () => xrpcAuthPost('net.openfederation.community.join', unverified.accessJwt, {
      did: 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa',
    });

    it('advisory (the default) gates nothing', async () => {
      if (!plcAvailable) return;
      config.emailVerification.policy = 'advisory';
      const res = await probe();
      expect(res.body.error).not.toBe('EmailNotVerified');
    });

    it('require-for-write refuses an acting endpoint for an unverified account', async () => {
      if (!plcAvailable) return;
      config.emailVerification.policy = 'require-for-write';
      const res = await probe();
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('EmailNotVerified');
    });

    it('require-for-login refuses a new session until verified, then admits', async () => {
      if (!plcAvailable) return;
      config.emailVerification.policy = 'require-for-login';

      const refused = await xrpcPost('com.atproto.server.createSession', {
        identifier: unverified.handle, password,
      });
      expect(refused.status).toBe(403);
      expect(refused.body.error).toBe('EmailNotVerified');

      // The way out must work while logged out — that is what keeps this
      // policy from deadlocking.
      const link = await waitForMail(`${unverified.handle}@test.local`);
      const confirm = await xrpcPost('com.atproto.server.confirmEmail', { email: link.email, token: link.token });
      expect(confirm.status).toBe(200);

      const admitted = await xrpcPost('com.atproto.server.createSession', {
        identifier: unverified.handle, password,
      });
      expect(admitted.status).toBe(200);
      expect(admitted.body.accessJwt).toBeTruthy();
    });

    it('write access returns once verified', async () => {
      if (!plcAvailable) return;
      config.emailVerification.policy = 'require-for-write';
      const res = await probe();
      expect(res.body.error).not.toBe('EmailNotVerified');
    });
  });
});
