/**
 * Email delivery reports what actually happened (#83, part A).
 *
 * The old `sendEmail` could not fail: unconfigured SMTP logged to console and
 * returned, a rejected send was swallowed. These tests pin the replacement's
 * whole contract — the outcome taxonomy, SMTP 4xx/5xx classification, bounded
 * retry, the suppression gate, and the `email_deliveries` record that makes
 * an operator's "did my mail go out" answerable.
 *
 * nodemailer is mocked at the module boundary: the classification logic is
 * what's under test, not the SMTP protocol.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

const sendMail = vi.fn();
const verify = vi.fn();
vi.mock('nodemailer', () => ({
  default: { createTransport: vi.fn(() => ({ sendMail, verify })) },
}));

import { sendEmail, verifyEmailTransport } from '../../src/email/email-service.js';
import { config } from '../../src/config.js';
import { query } from '../../src/db/client.js';

/** SMTP errors carry their status in `responseCode`, as nodemailer surfaces them. */
function smtpError(code: number, message: string): Error {
  const err = new Error(message) as Error & { responseCode: number };
  err.responseCode = code;
  return err;
}

async function deliveryRows(recipient: string) {
  const res = await query<{ status: string; attempts: number; error: string | null; provider_message_id: string | null }>(
    'SELECT status, attempts, error, provider_message_id FROM email_deliveries WHERE recipient = $1 ORDER BY created_at',
    [recipient],
  );
  return res.rows;
}

describe('sendEmail outcomes (#83)', () => {
  beforeAll(() => {
    // The transport reads config lazily; flip it on for this file only (each
    // vitest file gets its own module registry, so nothing leaks).
    config.email.enabled = true;
    config.email.host = 'smtp.test.invalid';
  });

  beforeEach(() => {
    sendMail.mockReset();
    verify.mockReset();
  });

  it('reports sent, with the provider message id, and records it', async () => {
    sendMail.mockResolvedValue({ messageId: '<abc@test>' });
    const result = await sendEmail('sent@example.test', 'S', '<p>b</p>', 'password-reset');

    expect(result).toEqual({ outcome: 'sent', messageId: '<abc@test>' });
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(await deliveryRows('sent@example.test')).toEqual([
      { status: 'sent', attempts: 1, error: null, provider_message_id: '<abc@test>' },
    ]);
  });

  it('treats a 5xx as permanent and does not retry', async () => {
    // Retrying a permanent rejection is how senders get blocklisted; the SMTP
    // server said stop asking, and one call proves we listened.
    sendMail.mockRejectedValue(smtpError(550, 'mailbox unavailable'));
    const result = await sendEmail('perm@example.test', 'S', '<p>b</p>', 'account-recovery');

    expect(result.outcome).toBe('failed-permanent');
    expect(sendMail).toHaveBeenCalledTimes(1);
    const [row] = await deliveryRows('perm@example.test');
    expect(row.status).toBe('failed-permanent');
    expect(row.error).toContain('mailbox unavailable');
  });

  it('retries a 4xx and succeeds on the second attempt', async () => {
    sendMail
      .mockRejectedValueOnce(smtpError(451, 'try again later'))
      .mockResolvedValueOnce({ messageId: '<retry@test>' });
    const result = await sendEmail('retry@example.test', 'S', '<p>b</p>');

    expect(result.outcome).toBe('sent');
    expect(sendMail).toHaveBeenCalledTimes(2);
    expect((await deliveryRows('retry@example.test'))[0]).toMatchObject({ status: 'sent', attempts: 2 });
  }, 20_000);

  it('exhausts retries on persistent connection failure and says so', async () => {
    // No responseCode at all — the server never answered. That is transient
    // by definition: it never got to express an opinion.
    sendMail.mockRejectedValue(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));
    const result = await sendEmail('down@example.test', 'S', '<p>b</p>');

    expect(result.outcome).toBe('failed-transient');
    expect(sendMail).toHaveBeenCalledTimes(3);
    expect((await deliveryRows('down@example.test'))[0]).toMatchObject({ status: 'failed-transient', attempts: 3 });
  }, 20_000);

  it('refuses a suppressed address without contacting the server', async () => {
    await query(
      `INSERT INTO email_suppressions (recipient, reason, source) VALUES ($1, 'hard-bounce', 'test')
       ON CONFLICT (recipient) DO NOTHING`,
      ['bounced@example.test'],
    );
    const result = await sendEmail('bounced@example.test', 'S', '<p>b</p>');

    expect(result).toEqual({ outcome: 'suppressed', reason: 'hard-bounce' });
    expect(sendMail).not.toHaveBeenCalled();
    expect((await deliveryRows('bounced@example.test'))[0]).toMatchObject({ status: 'suppressed' });
  });

  it('verifies the transport and reports unreachable with the reason', async () => {
    verify.mockResolvedValueOnce(true);
    expect(await verifyEmailTransport()).toEqual({ state: 'ok' });

    verify.mockRejectedValueOnce(new Error('getaddrinfo ENOTFOUND smtp.test.invalid'));
    const result = await verifyEmailTransport();
    expect(result.state).toBe('unreachable');
    expect((result as { error: string }).error).toContain('ENOTFOUND');
  });
});

describe('sendEmail without SMTP configured', () => {
  it('says not-configured and records that, instead of pretending', async () => {
    config.email.enabled = false;
    const result = await sendEmail('nobody@example.test', 'S', '<p>b</p>', 'password-reset');
    config.email.enabled = true;

    // The outcome that used to be indistinguishable from success: the caller
    // can now decide whether "no mail system" is acceptable for its purpose.
    expect(result.outcome).toBe('not-configured');
    expect((await deliveryRows('nobody@example.test'))[0]).toMatchObject({ status: 'not-configured', attempts: 0 });
  });
});
