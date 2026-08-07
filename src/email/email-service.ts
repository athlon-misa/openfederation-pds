/**
 * Email delivery that tells the truth about what happened (#83, part A).
 *
 * The previous version could not fail: with no SMTP configured it logged to
 * the console and returned, and a rejected send was caught and swallowed. So
 * `requestPasswordReset` reported success while delivering nothing — to this
 * day no email has ever actually left this system, and nothing would have
 * said so. For an operator self-hosting Postfix, where day-one
 * misconfiguration is the norm, that silence is the difference between "my
 * mail server is broken" and "the PDS is silently broken".
 *
 * `sendEmail` now returns a discriminated outcome and still never throws —
 * callers differ in what a failure means (an unsendable password-changed
 * *notification* is a log line; an unsendable password-reset *link* is a lie
 * to the user) and that judgment belongs at the call site, not here.
 *
 * Transient SMTP failures (4xx, connection errors) are retried in-process
 * with short backoff. Retry is deliberately NOT durable: a durable outbox
 * would have to store the rendered body, and reset/recovery bodies carry live
 * secret URLs — the same tokens the database deliberately stores only as
 * hashes so a DB compromise cannot mint valid links. An email that exhausts
 * its retries is recorded as failed, and the recovery path is the human one:
 * the user requests another.
 *
 * Every attempt-set lands in `email_deliveries` (recipient, purpose, outcome,
 * error, provider message id). That is the operator's ground truth for "did
 * my mail go out", and the substrate bounce webhooks correlate against.
 * Suppressed addresses (hard bounces, complaints — part A4) are checked
 * before any send and refused with their own outcome.
 */
import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { randomUUID } from 'crypto';
import { config } from '../config.js';
import { query } from '../db/client.js';

/** Why this email was sent — recorded, and useful to filter deliveries by. */
export type EmailPurpose =
  | 'password-reset'
  | 'password-changed'
  | 'account-recovery'
  | 'recovery-complete'
  | 'session-revoked'
  | 'admin-verification'
  | 'email-verification'
  | 'other';

export type DeliveryOutcome =
  /** Accepted by the SMTP server. Delivery beyond that is the provider's word. */
  | { outcome: 'sent'; messageId: string | null }
  /** No SMTP configured. Dev mode logs the message; production should never be here. */
  | { outcome: 'not-configured' }
  /** The address is on the suppression list (hard bounce or complaint). */
  | { outcome: 'suppressed'; reason: string }
  /** Retried and still failing on something that may recover (4xx, network). */
  | { outcome: 'failed-transient'; error: string }
  /** The server said no in a way retrying will not change (5xx). */
  | { outcome: 'failed-permanent'; error: string };

export type EmailSender = (to: string, subject: string, html: string) => Promise<void>;

let testSender: EmailSender | null = null;

/** Pass null to restore the real transport. Test-only. */
export function setEmailSenderForTests(sender: EmailSender | null): void {
  testSender = sender;
}

let transporter: Transporter | null = null;

function getTransporter(): Transporter | null {
  if (!config.email.enabled) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: config.email.host,
      port: config.email.port,
      secure: config.email.secure,
      auth: config.email.user ? {
        user: config.email.user,
        pass: config.email.password,
      } : undefined,
    });
  }
  return transporter;
}

/**
 * Verify the configured transport can actually be reached and authenticated.
 * Called once at startup so a broken SMTP configuration is a boot-time
 * headline instead of a per-request silence. Returns a reason rather than
 * throwing, and distinguishes "no SMTP" — a deliberate operator choice —
 * from a configured transport that does not answer.
 */
export async function verifyEmailTransport(): Promise<
  { state: 'ok' } | { state: 'not-configured' } | { state: 'unreachable'; error: string }
> {
  const t = getTransporter();
  if (!t) return { state: 'not-configured' };
  try {
    await t.verify();
    return { state: 'ok' };
  } catch (err) {
    return { state: 'unreachable', error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * SMTP semantics: 4xx asks you to try again later, 5xx means stop asking.
 * Connection-level failures (refused, timed out, DNS) are transient — the
 * server never got to express an opinion.
 */
function classify(err: unknown): 'transient' | 'permanent' {
  const code = (err as { responseCode?: number })?.responseCode;
  if (typeof code === 'number') return code >= 500 ? 'permanent' : 'transient';
  return 'transient';
}

const RETRY_DELAYS_MS = [1_000, 5_000];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function isSuppressed(recipient: string): Promise<string | null> {
  try {
    const res = await query<{ reason: string }>(
      'SELECT reason FROM email_suppressions WHERE recipient = $1',
      [recipient.toLowerCase()],
    );
    return res.rows[0]?.reason ?? null;
  } catch {
    // A failing suppression lookup must not block mail: the list is a
    // reputation optimisation, not a correctness gate.
    return null;
  }
}

async function recordDelivery(row: {
  recipient: string;
  purpose: EmailPurpose;
  status: string;
  messageId?: string | null;
  error?: string | null;
  attempts: number;
}): Promise<void> {
  try {
    await query(
      `INSERT INTO email_deliveries (id, recipient, purpose, status, provider_message_id, error, attempts)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [randomUUID(), row.recipient.toLowerCase(), row.purpose, row.status,
        row.messageId ?? null, row.error ?? null, row.attempts],
    );
  } catch (err) {
    // The record is observability, not the delivery itself. Losing it is
    // logged; failing the send over it would invert the priorities.
    console.error('[email] could not record delivery:', err instanceof Error ? err.message : err);
  }
}

export async function sendEmail(
  to: string,
  subject: string,
  html: string,
  purpose: EmailPurpose = 'other',
): Promise<DeliveryOutcome> {
  if (testSender) {
    await testSender(to, subject, html);
    return { outcome: 'sent', messageId: null };
  }

  const suppressionReason = await isSuppressed(to);
  if (suppressionReason) {
    await recordDelivery({ recipient: to, purpose, status: 'suppressed', error: suppressionReason, attempts: 0 });
    return { outcome: 'suppressed', reason: suppressionReason };
  }

  const t = getTransporter();
  if (!t) {
    // Dev mode — log to console. Recorded too, so the deliveries table is an
    // honest history even before an operator configures SMTP.
    console.log(`[EMAIL] To: ${to}`);
    console.log(`[EMAIL] Subject: ${subject}`);
    console.log(`[EMAIL] Body: ${html.replace(/<[^>]+>/g, '').substring(0, 200)}...`);
    await recordDelivery({ recipient: to, purpose, status: 'not-configured', attempts: 0 });
    return { outcome: 'not-configured' };
  }

  let lastError = '';
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) await sleep(RETRY_DELAYS_MS[attempt - 1]);
    try {
      const info = await t.sendMail({ from: config.email.from, to, subject, html });
      const messageId: string | null = info?.messageId ?? null;
      await recordDelivery({ recipient: to, purpose, status: 'sent', messageId, attempts: attempt + 1 });
      return { outcome: 'sent', messageId };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (classify(err) === 'permanent') {
        console.error(`[email] permanent failure to ${to} (${purpose}): ${lastError}`);
        await recordDelivery({ recipient: to, purpose, status: 'failed-permanent', error: lastError, attempts: attempt + 1 });
        return { outcome: 'failed-permanent', error: lastError };
      }
      console.warn(`[email] transient failure to ${to} (${purpose}), attempt ${attempt + 1}: ${lastError}`);
    }
  }

  await recordDelivery({
    recipient: to, purpose, status: 'failed-transient', error: lastError, attempts: RETRY_DELAYS_MS.length + 1,
  });
  return { outcome: 'failed-transient', error: lastError };
}
