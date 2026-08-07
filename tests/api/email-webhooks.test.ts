/**
 * Bounce and complaint webhooks (#83, part A4).
 *
 * The contract under test: a hard bounce or complaint suppresses the address
 * (and `sendEmail` then refuses it), a soft bounce is recorded but never
 * suppresses, and none of it exists at all without the shared token — a
 * scanner probing the path learns nothing.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { api } from './helpers.js';
import { sendEmail } from '../../src/email/email-service.js';
import { query } from '../../src/db/client.js';

const TOKEN = 'test-webhook-token-83';

async function suppressionOf(recipient: string) {
  const res = await query<{ reason: string; source: string }>(
    'SELECT reason, source FROM email_suppressions WHERE recipient = $1',
    [recipient],
  );
  return res.rows[0] ?? null;
}

describe('email bounce webhooks (#83)', () => {
  const hadToken = process.env.EMAIL_WEBHOOK_TOKEN;

  beforeAll(() => { process.env.EMAIL_WEBHOOK_TOKEN = TOKEN; });
  afterAll(() => {
    if (hadToken === undefined) delete process.env.EMAIL_WEBHOOK_TOKEN;
    else process.env.EMAIL_WEBHOOK_TOKEN = hadToken;
  });

  it('does not exist without the token, and 404s on a wrong one', async () => {
    delete process.env.EMAIL_WEBHOOK_TOKEN;
    const unconfigured = await api.post('/webhooks/email/postmark').send({ RecordType: 'Bounce' });
    expect(unconfigured.status).toBe(404);
    process.env.EMAIL_WEBHOOK_TOKEN = TOKEN;

    const wrong = await api.post(`/webhooks/email/postmark?token=not-it`).send({ RecordType: 'Bounce' });
    expect(wrong.status).toBe(404);

    const unknownProvider = await api.post(`/webhooks/email/sendgrid?token=${TOKEN}`).send({});
    expect(unknownProvider.status).toBe(404);
  });

  it('suppresses a Postmark hard bounce, and sendEmail then refuses the address', async () => {
    const res = await api.post(`/webhooks/email/postmark?token=${TOKEN}`).send({
      RecordType: 'Bounce', Type: 'HardBounce', Email: 'Gone@Example.Test',
    });
    expect(res.status).toBe(200);
    expect(res.body.suppressed).toBe(1);

    // Case-normalised on the way in, matched on the way out.
    expect(await suppressionOf('gone@example.test')).toEqual({ reason: 'hard-bounce', source: 'postmark' });

    // The point of the list: the next send to this address never leaves.
    const outcome = await sendEmail('gone@example.test', 'S', '<p>b</p>');
    expect(outcome.outcome).toBe('suppressed');
  });

  it('records a Postmark soft bounce without suppressing', async () => {
    const res = await api.post(`/webhooks/email/postmark?token=${TOKEN}`).send({
      RecordType: 'Bounce', Type: 'Transient', Email: 'full@example.test',
    });
    expect(res.status).toBe(200);
    expect(res.body.suppressed).toBe(0);

    // A full mailbox describes a moment, not an address.
    expect(await suppressionOf('full@example.test')).toBeNull();
    const rows = await query<{ status: string }>(
      `SELECT status FROM email_deliveries WHERE recipient = 'full@example.test'`,
    );
    expect(rows.rows.map(r => r.status)).toContain('soft-bounce');
  });

  it('suppresses a Resend complaint', async () => {
    const res = await api.post(`/webhooks/email/resend?token=${TOKEN}`).send({
      type: 'email.complained', data: { to: ['angry@example.test'] },
    });
    expect(res.status).toBe(200);
    expect(await suppressionOf('angry@example.test')).toEqual({ reason: 'complaint', source: 'resend' });
  });

  it('unwraps an SNS-wrapped SES hard bounce', async () => {
    const res = await api.post(`/webhooks/email/ses?token=${TOKEN}`).send({
      Type: 'Notification',
      Message: JSON.stringify({
        notificationType: 'Bounce',
        bounce: { bounceType: 'Permanent', bouncedRecipients: [{ emailAddress: 'void@example.test' }] },
      }),
    });
    expect(res.status).toBe(200);
    expect(await suppressionOf('void@example.test')).toEqual({ reason: 'hard-bounce', source: 'ses' });
  });

  it('logs an SNS subscription confirmation instead of fetching it', async () => {
    // Fetching a URL out of an inbound body would be SSRF; the operator
    // confirms manually.
    const res = await api.post(`/webhooks/email/ses?token=${TOKEN}`).send({
      Type: 'SubscriptionConfirmation',
      SubscribeURL: 'https://sns.example.amazonaws.com/confirm?x=1',
    });
    expect(res.status).toBe(200);
    expect(res.body.action).toBe('confirmation-logged');
    expect(await suppressionOf('void2@example.test')).toBeNull();
  });
});
