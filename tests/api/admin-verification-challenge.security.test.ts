/**
 * An admin identity-verification code must only ever verify identity.
 *
 * The code is emailed to the user so they can read it to an administrator.
 * It must not be redeemable as a password-reset token by whoever hears it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  xrpcPost, xrpcAuthPost, createTestUser, getAdminToken, isPLCAvailable, uniqueHandle,
} from './helpers.js';
import { setEmailSenderForTests } from '../../src/email/email-service.js';

const inbox: Array<{ to: string; subject: string; html: string }> = [];

function codeFor(email: string): string {
  const mail = [...inbox].reverse().find(m => m.to === email && m.subject.includes('Identity Verification'));
  const code = mail?.html.match(/letter-spacing: 2px;">([0-9a-f]{64})</)?.[1];
  if (!code) throw new Error(`no verification code captured for ${email}`);
  return code;
}

describe('admin verification challenge', () => {
  let plcAvailable: boolean;
  let adminToken: string;

  beforeAll(async () => {
    plcAvailable = await isPLCAvailable();
    adminToken = await getAdminToken();
    setEmailSenderForTests(async (to, subject, html) => { inbox.push({ to, subject, html }); });
  });
  afterAll(() => setEmailSenderForTests(null));

  it('cannot be redeemed as a password reset', async () => {
    if (!plcAvailable) return;
    const handle = uniqueHandle('vchal');
    const user = await createTestUser(handle);
    const email = `${handle}@test.local`;

    const created = await xrpcAuthPost('net.openfederation.admin.createVerificationChallenge', adminToken, { did: user.did });
    expect(created.status).toBe(200);
    const code = codeFor(email);

    for (const token of [`verify:${code}`, code]) {
      const reset = await xrpcPost('net.openfederation.account.confirmPasswordReset', {
        token, newPassword: 'AttackerPassword999!',
      });
      expect(reset.status).toBe(400);
    }

    const stillOld = await xrpcPost('com.atproto.server.createSession', { identifier: handle, password: 'TestPassword123!' });
    expect(stillOld.status).toBe(200);
    const notNew = await xrpcPost('com.atproto.server.createSession', { identifier: handle, password: 'AttackerPassword999!' });
    expect(notNew.status).toBe(401);
  });

  it('still verifies identity, and survives the user asking for a password reset', async () => {
    if (!plcAvailable) return;
    const handle = uniqueHandle('vchal');
    const user = await createTestUser(handle);
    const email = `${handle}@test.local`;

    await xrpcAuthPost('net.openfederation.admin.createVerificationChallenge', adminToken, { did: user.did });
    const code = codeFor(email);

    // Anyone who knows the email can request a reset; that must not void the challenge.
    await xrpcPost('net.openfederation.account.requestPasswordReset', { identifier: email });

    const verified = await xrpcAuthPost('net.openfederation.admin.verifyChallenge', adminToken, { did: user.did, nonce: code });
    expect(verified.status).toBe(200);
    expect(verified.body.verified).toBe(true);
  });
});
