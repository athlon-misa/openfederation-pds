import { describe, it, expect, afterEach } from 'vitest';
import { sendEmail, setEmailSenderForTests } from '../../src/email/email-service.js';

afterEach(() => setEmailSenderForTests(null));

describe('email sender seam', () => {
  it('routes sendEmail through the injected sender', async () => {
    const sent: Array<{ to: string; subject: string }> = [];
    setEmailSenderForTests(async (to, subject) => {
      sent.push({ to, subject });
    });
    await sendEmail('a@b.c', 'Hello', '<p>hi</p>');
    expect(sent).toEqual([{ to: 'a@b.c', subject: 'Hello' }]);
  });
});
