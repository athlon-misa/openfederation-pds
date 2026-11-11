/**
 * The notice an `assisted` account gets whenever this server signs a PLC
 * update for it (ADR-003, decision 10). The person's own key ranks higher and
 * can cancel the update within 72 hours, but only if they hear about it.
 */
import { query } from '../db/client.js';
import { sendEmail } from '../email/email-service.js';
import { serverSignedUpdateEmail } from '../email/templates.js';

export const CANCEL_WINDOW_MS = 72 * 60 * 60 * 1000;

/** Emails the account if it is `assisted`; returns until when the update can be cancelled. */
export async function noticeServerSignedUpdate(did: string, operationCid: string, why: string): Promise<Date> {
  const cancelUntil = new Date(Date.now() + CANCEL_WINDOW_MS);
  const row = (await query<{ handle: string; email: string | null; custody_mode: string | null }>(
    'SELECT handle, email, custody_mode FROM users WHERE did = $1', [did])).rows[0];
  if (row?.custody_mode === 'assisted' && row.email) {
    await sendEmail(row.email, 'Your identity was changed by this server — OpenFederation',
      serverSignedUpdateEmail({ handle: row.handle, operationCid, why, cancelUntil }), 'other').catch(() => undefined);
  }
  return cancelUntil;
}
