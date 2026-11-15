/**
 * The notice an `assisted` account gets whenever this server signs a PLC
 * update for it (ADR-003, decision 10). The person's own key ranks higher and
 * can cancel the update within 72 hours, but only if they hear about it.
 */
import { query } from '../db/client.js';
import { sendEmail } from '../email/email-service.js';
import { deviceSigningSwitchedOffEmail, serverSignedUpdateEmail } from '../email/templates.js';

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

/**
 * Device signing (#240) was turned off here because PLC names this server's
 * repo key again, without the person telling this server (an `assisted`
 * switch back with the backup key, or a phrase-signed change made elsewhere).
 * The person hears about it, so a switch back they did not make can be
 * cancelled in time.
 */
export async function noticeDeviceSigningSwitchedOff(did: string): Promise<void> {
  const row = (await query<{ handle: string; email: string | null; custody_mode: string | null }>(
    'SELECT handle, email, custody_mode FROM users WHERE did = $1', [did])).rows[0];
  if (!row?.email) return;
  await sendEmail(row.email, 'Device signing is off — OpenFederation',
    deviceSigningSwitchedOffEmail({ handle: row.handle, assisted: row.custody_mode === 'assisted' }), 'other').catch(() => undefined);
}
