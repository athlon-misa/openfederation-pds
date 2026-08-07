/**
 * Bounce and complaint webhooks (#83, part A4).
 *
 * A hard bounce means the address does not exist; a complaint means the
 * recipient marked us as spam. Sending again to either burns the operator's
 * sender reputation — which for a self-hosting operator is the scarcest
 * resource they have. Providers report both by webhook; this endpoint turns
 * those reports into `email_suppressions` rows, which `sendEmail` checks
 * before every send.
 *
 * The provider payloads share nothing, so each gets an adapter — but they are
 * all reduced to the same two facts: which address, and was it permanent.
 * Soft bounces (mailbox full, greylisting) are recorded in the deliveries
 * table and deliberately NOT suppressed: they describe a moment, not an
 * address.
 *
 * Authentication is a shared token in the URL, compared in constant time.
 * All three providers accept an arbitrary webhook URL, so one mechanism
 * covers them where their native schemes diverge (Postmark offers basic
 * auth, Resend signs with Svix, SES wraps in SNS). The routes do not exist
 * at all until `EMAIL_WEBHOOK_TOKEN` is set — off by default, like every
 * other optional module here.
 *
 * SES note: SNS subscription handshakes carry a `SubscribeURL` the service
 * expects you to fetch. Auto-fetching a URL from an inbound request body is
 * SSRF by design, so it is logged for the operator to confirm manually
 * instead. One click, once, at setup time.
 */
import { Router, type Request, type Response } from 'express';
import { timingSafeEqual } from 'crypto';
import { query } from '../db/client.js';
import { auditLog } from '../db/audit.js';

type Verdict = { email: string; kind: 'hard-bounce' | 'complaint' | 'soft-bounce' };

function constantTimeMatch(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Postmark: https://postmarkapp.com/developer/webhooks/bounce-webhook */
function parsePostmark(body: any): Verdict[] {
  const email = typeof body?.Email === 'string' ? body.Email : null;
  if (!email) return [];
  if (body.RecordType === 'SpamComplaint') return [{ email, kind: 'complaint' }];
  if (body.RecordType === 'Bounce') {
    return [{ email, kind: body.Type === 'HardBounce' ? 'hard-bounce' : 'soft-bounce' }];
  }
  return [];
}

/** Resend: https://resend.com/docs/dashboard/webhooks/event-types */
function parseResend(body: any): Verdict[] {
  const recipients: string[] = Array.isArray(body?.data?.to) ? body.data.to.filter((t: unknown) => typeof t === 'string') : [];
  if (body?.type === 'email.complained') return recipients.map((email) => ({ email, kind: 'complaint' as const }));
  if (body?.type === 'email.bounced') {
    const hard = body?.data?.bounce?.type !== 'Transient';
    return recipients.map((email) => ({ email, kind: hard ? 'hard-bounce' as const : 'soft-bounce' as const }));
  }
  return [];
}

/** SES notifications arrive wrapped in SNS; `Message` is a JSON string. */
function parseSes(body: any): Verdict[] {
  let message = body;
  if (typeof body?.Message === 'string') {
    try { message = JSON.parse(body.Message); } catch { return []; }
  }
  if (message?.notificationType === 'Complaint') {
    const rs = message?.complaint?.complainedRecipients ?? [];
    return rs.filter((r: any) => typeof r?.emailAddress === 'string')
      .map((r: any) => ({ email: r.emailAddress, kind: 'complaint' as const }));
  }
  if (message?.notificationType === 'Bounce') {
    const hard = message?.bounce?.bounceType === 'Permanent';
    const rs = message?.bounce?.bouncedRecipients ?? [];
    return rs.filter((r: any) => typeof r?.emailAddress === 'string')
      .map((r: any) => ({ email: r.emailAddress, kind: hard ? 'hard-bounce' as const : 'soft-bounce' as const }));
  }
  return [];
}

const PARSERS: Record<string, (body: any) => Verdict[]> = {
  postmark: parsePostmark,
  resend: parseResend,
  ses: parseSes,
};

export function createEmailWebhookRouter(): Router {
  const router = Router();

  router.post('/webhooks/email/:provider', async (req: Request, res: Response) => {
    // Token unset → the routes do not exist. 404, not 401: an unauthenticated
    // scanner learns nothing about what this server would accept.
    const expected = process.env.EMAIL_WEBHOOK_TOKEN;
    const given = typeof req.query.token === 'string' ? req.query.token : '';
    if (!expected || !constantTimeMatch(given, expected)) {
      res.status(404).json({ error: 'NotFound' });
      return;
    }

    const provider = String(req.params.provider);
    const parser = PARSERS[provider];
    if (!parser) {
      res.status(404).json({ error: 'NotFound', message: 'Unknown provider' });
      return;
    }

    // SNS handshake: log the confirmation URL for the operator instead of
    // fetching a URL supplied by the request body (that would be SSRF).
    if (provider === 'ses' && req.body?.Type === 'SubscriptionConfirmation') {
      console.warn('[email] SNS subscription confirmation received. Visit this URL to confirm:');
      console.warn(`[email]   ${String(req.body.SubscribeURL).slice(0, 500)}`);
      res.status(200).json({ ok: true, action: 'confirmation-logged' });
      return;
    }

    try {
      const verdicts = parser(req.body ?? {});
      let suppressed = 0;
      for (const v of verdicts) {
        const email = v.email.toLowerCase();
        if (v.kind === 'soft-bounce') {
          // A moment, not an address: recorded so the operator sees it,
          // never suppressed.
          await query(
            `INSERT INTO email_deliveries (id, recipient, purpose, status, error, attempts)
             VALUES (gen_random_uuid(), $1, 'other', 'soft-bounce', $2, 0)`,
            [email, `reported by ${provider}`],
          );
          continue;
        }
        await query(
          `INSERT INTO email_suppressions (recipient, reason, source)
           VALUES ($1, $2, $3)
           ON CONFLICT (recipient) DO NOTHING`,
          [email, v.kind, provider],
        );
        suppressed++;
        await auditLog('email.suppression.add', null, email, {
          reason: v.kind,
          source: provider,
        });
      }
      res.status(200).json({ ok: true, processed: verdicts.length, suppressed });
    } catch (err) {
      console.error('[email] webhook processing failed:', err instanceof Error ? err.message : err);
      // 500 so the provider retries — their retry is the durable queue here.
      res.status(500).json({ error: 'InternalServerError' });
    }
  });

  return router;
}
