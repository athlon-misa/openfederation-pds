/**
 * The links in password-reset and recovery emails have to lead somewhere.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { api, xrpcPost, createTestUser, isPLCAvailable, uniqueHandle } from './helpers.js';
import { setEmailSenderForTests } from '../../src/email/email-service.js';

const inbox: Array<{ to: string; subject: string; html: string }> = [];

describe('account pages linked from email', () => {
  beforeAll(() => setEmailSenderForTests(async (to, subject, html) => { inbox.push({ to, subject, html }); }));
  afterAll(() => setEmailSenderForTests(null));

  it('serves the reset and recovery pages, wired to the right methods', async () => {
    const reset = await api.get('/reset-password?token=abc');
    expect(reset.status).toBe(200);
    expect(reset.headers['content-type']).toMatch(/html/);
    expect(reset.text).toContain('net.openfederation.account.confirmPasswordReset');
    expect(reset.text).toContain('/account-forms.js');
    // The one-time token from the address is never echoed into the page.
    expect(reset.text).not.toContain('abc');
    expect(reset.headers['cache-control']).toBe('no-store');

    const recover = await api.get('/recover?token=abc');
    expect(recover.status).toBe(200);
    expect(recover.text).toContain('net.openfederation.account.completeRecovery');

    const script = await api.get('/account-forms.js');
    expect(script.status).toBe(200);
    expect(script.headers['content-type']).toMatch(/javascript/);
    expect(script.text).toContain("'/xrpc/'");
  });

  it('the link in a reset email opens a page, and its token resets the password', async () => {
    if (!(await isPLCAvailable())) return;
    const handle = uniqueHandle('resetlink');
    await createTestUser(handle);
    const email = `${handle}@test.local`;
    await xrpcPost('net.openfederation.account.requestPasswordReset', { identifier: email });

    let link: string | undefined;
    for (let i = 0; i < 50 && !link; i++) {
      const mail = [...inbox].reverse().find((m) => m.to === email && m.subject.includes('Password Reset'));
      link = mail?.html.match(/https?:\/\/[^"'\s<]+\/reset-password\?token=[^"'\s<&]+/)?.[0];
      if (!link) await new Promise((r) => setTimeout(r, 100));
    }
    expect(link, 'reset link in the email').toBeTruthy();
    const url = new URL(link!);

    const pageRes = await api.get(`${url.pathname}${url.search}`);
    expect(pageRes.status).toBe(200);

    const done = await xrpcPost('net.openfederation.account.confirmPasswordReset', {
      token: url.searchParams.get('token'), newPassword: 'FreshPassword2468!',
    });
    expect(done.status).toBe(200);
    const login = await xrpcPost('com.atproto.server.createSession', { identifier: handle, password: 'FreshPassword2468!' });
    expect(login.status).toBe(200);
  });
});
