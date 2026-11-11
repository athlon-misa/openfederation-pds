/**
 * Takedown policy (docs/FAIR-USE.md), the same for accounts and communities.
 *
 *  - standard: the PDS's rules were broken, nothing illegal. Hidden at once;
 *    the owner is emailed a private export link and has EXPORT_WINDOW_DAYS to
 *    use it, with a reminder REMINDER_DAYS_BEFORE the end. Then the data is
 *    deleted. Exporting does not extend anything: the PDS is not a backup.
 *  - hard: illegal content is evident. Hidden at once; no owner export; kept
 *    unchanged for LEGAL_HOLD_DAYS (requests from authorities), then deleted.
 *
 * An admin can reverse either before the deadline, move a takedown between
 * tiers, set a different deadline, or delete earlier through the existing
 * delete endpoints. The DID stays at the PLC directory, so an exported
 * repository can be brought to another PDS after the deletion.
 */
import { createHash, randomBytes } from 'node:crypto';
import { config } from '../config.js';
import { query, withTransaction } from '../db/client.js';
import { auditLog } from '../db/audit.js';
import { sendEmail } from '../email/email-service.js';
import { takedownNoticeEmail, takedownExportedEmail, takedownReminderEmail } from '../email/templates.js';
import { revokeOAuthGrants } from '../auth/revoke-grants.js';
import { invalidateAuthContext } from '../auth/auth-context-cache.js';
import { deleteAccountData, removeBlobFiles } from '../identity/delete-account.js';
import { deleteCommunityData } from '../community/delete-community.js';
import { runIfDue } from '../scheduler/schedule.js';

export const EXPORT_WINDOW_DAYS = 30;
export const LEGAL_HOLD_DAYS = 90;
export const REMINDER_DAYS_BEFORE = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

export type TakedownTier = 'standard' | 'hard';
export type SubjectKind = 'account' | 'community';

export function isTakedownTier(value: unknown): value is TakedownTier {
  return value === 'standard' || value === 'hard';
}

export interface TakedownSubject {
  kind: SubjectKind;
  did: string;
  handle: string;
  status: string;
  tier: TakedownTier | null;
  deleteAfter: Date | null;
  /** users.id of the account, or of the community's owner. */
  userId: string | null;
  isAdminAccount: boolean;
  email: string | null;
}

export async function findTakedownSubject(did: string): Promise<TakedownSubject | null> {
  const user = await query<{ id: string; handle: string; status: string; takedown_tier: TakedownTier | null; takedown_delete_after: Date | null; email: string | null; is_admin: boolean }>(
    `SELECT u.id, u.handle, u.status, u.takedown_tier, u.takedown_delete_after, u.email,
            EXISTS (SELECT 1 FROM user_roles r WHERE r.user_id = u.id AND r.role = 'admin') AS is_admin
     FROM users u WHERE u.did = $1`, [did]);
  if (user.rows[0]) {
    const u = user.rows[0];
    return { kind: 'account', did, handle: u.handle, status: u.status, tier: u.takedown_tier, deleteAfter: u.takedown_delete_after, userId: u.id, isAdminAccount: u.is_admin, email: u.email };
  }
  const community = await query<{ handle: string; status: string; takedown_tier: TakedownTier | null; takedown_delete_after: Date | null; owner_id: string | null; email: string | null }>(
    `SELECT c.handle, c.status, c.takedown_tier, c.takedown_delete_after, o.id AS owner_id, o.email
     FROM communities c LEFT JOIN users o ON o.did = c.owner_did WHERE c.did = $1`, [did]);
  if (community.rows[0]) {
    const c = community.rows[0];
    return { kind: 'community', did, handle: c.handle, status: c.status, tier: c.takedown_tier, deleteAfter: c.takedown_delete_after, userId: c.owner_id, isAdminAccount: false, email: c.email };
  }
  return null;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** A new private export link, valid until the deletion date. */
async function issueExportLink(subject: TakedownSubject, expiresAt: Date): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await query(
    `INSERT INTO takedown_export_tokens (token_hash, subject_did, subject_kind, expires_at) VALUES ($1, $2, $3, $4)`,
    [hashToken(token), subject.did, subject.kind, expiresAt]);
  return `${config.pds.serviceUrl.replace(/\/$/, '')}/takedown-export/${token}`;
}

/** The subject an export link opens, if the link is valid and the takedown still allows owner export. */
export async function resolveExportToken(token: string): Promise<TakedownSubject | null> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const row = await query<{ subject_did: string }>(
    'SELECT subject_did FROM takedown_export_tokens WHERE token_hash = $1 AND expires_at > NOW()', [hashToken(token)]);
  if (!row.rows[0]) return null;
  const subject = await findTakedownSubject(row.rows[0].subject_did);
  if (!subject || subject.status !== 'takendown' || subject.tier !== 'standard') return null;
  return subject;
}

function table(kind: SubjectKind): 'users' | 'communities' {
  return kind === 'account' ? 'users' : 'communities';
}

async function notify(subject: TakedownSubject, title: string, html: string): Promise<void> {
  if (!subject.email) return;
  try {
    await sendEmail(subject.email, title, html, 'moderation');
  } catch (err) {
    console.error('[takedown] could not send %s notice:', subject.kind, err instanceof Error ? err.message : err);
  }
}

export interface TakedownInput {
  tier: TakedownTier;
  reason: string;
  actorUserId: string;
  /** Overrides the tier's default deadline (an admin extending a legal hold, say). */
  deleteAfter?: Date;
  /** False keeps the owner uninformed, for example when an authority asks. Default true. */
  notifyOwner?: boolean;
}

export interface TakedownResult {
  did: string;
  kind: SubjectKind;
  tier: TakedownTier;
  deleteAfter: Date;
  exportUrl?: string;
}

/**
 * Take a subject down, or change the tier or deadline of a takedown already in
 * place (escalating standard to hard ends owner export at once).
 */
export async function applyTakedown(subject: TakedownSubject, input: TakedownInput): Promise<TakedownResult> {
  const days = input.tier === 'standard' ? EXPORT_WINDOW_DAYS : LEGAL_HOLD_DAYS;
  const deleteAfter = input.deleteAfter ?? new Date(Date.now() + days * DAY_MS);
  const t = table(subject.kind);
  const already = subject.status === 'takendown';

  if (already) {
    await query(
      `UPDATE ${t} SET takedown_tier = $1, takedown_delete_after = $2, takedown_reminded_at = NULL,
              status_reason = $3, status_changed_by = $4, status_changed_at = CURRENT_TIMESTAMP
       WHERE did = $5`,
      [input.tier, deleteAfter, input.reason, input.actorUserId, subject.did]);
  } else {
    const tokenBump = subject.kind === 'account' ? ', token_version = token_version + 1' : '';
    await query(
      `UPDATE ${t}
       SET prior_status = CASE WHEN status = 'suspended' THEN prior_status ELSE status END,
           status = 'takendown', status_changed_at = CURRENT_TIMESTAMP,
           status_changed_by = $1, status_reason = $2,
           takedown_tier = $3, takedown_delete_after = $4,
           takedown_reminded_at = NULL, takedown_exported_at = NULL${tokenBump}
       WHERE did = $5`,
      [input.actorUserId, input.reason, input.tier, deleteAfter, subject.did]);
  }

  // Old links never outlive a change: a hard takedown has none, and a new
  // deadline gets a new link.
  await query('DELETE FROM takedown_export_tokens WHERE subject_did = $1', [subject.did]);

  if (subject.kind === 'account' && subject.userId) {
    await query('UPDATE sessions SET revoked_at = CURRENT_TIMESTAMP WHERE user_id = $1 AND revoked_at IS NULL', [subject.userId]);
    await revokeOAuthGrants(subject.did);
    invalidateAuthContext(subject.did);
  }

  await auditLog(`${subject.kind}.takedown`, input.actorUserId, subject.kind === 'account' ? subject.userId! : subject.did, {
    did: subject.did, tier: input.tier, reason: input.reason, deleteAfter: deleteAfter.toISOString(),
    previousStatus: subject.status, ...(already ? { changed: true } : {}),
  });

  const result: TakedownResult = { did: subject.did, kind: subject.kind, tier: input.tier, deleteAfter };
  if (input.tier === 'standard') result.exportUrl = await issueExportLink(subject, deleteAfter);

  if (input.notifyOwner !== false) {
    await notify(subject, `Your ${subject.kind} ${subject.handle} has been taken down — OpenFederation`,
      takedownNoticeEmail({ kind: subject.kind, handle: subject.handle, tier: input.tier, reason: input.reason, deleteAfter, exportUrl: result.exportUrl }));
  }
  return result;
}

/** Lift a takedown: the subject goes back to what it was before, and its export links stop working. */
export async function reverseTakedown(subject: TakedownSubject, actorUserId: string): Promise<string> {
  const t = table(subject.kind);
  const fallback = subject.kind === 'account' ? 'approved' : 'active';
  const tokenBump = subject.kind === 'account' ? ', token_version = token_version + 1' : '';
  const restored = await query<{ status: string }>(
    `UPDATE ${t}
     SET status = COALESCE(prior_status, '${fallback}'), prior_status = NULL,
         status_changed_at = CURRENT_TIMESTAMP, status_changed_by = $1, status_reason = NULL,
         takedown_tier = NULL, takedown_delete_after = NULL,
         takedown_reminded_at = NULL, takedown_exported_at = NULL${tokenBump}
     WHERE did = $2 RETURNING status`,
    [actorUserId, subject.did]);
  await query('DELETE FROM takedown_export_tokens WHERE subject_did = $1', [subject.did]);
  if (subject.kind === 'account') invalidateAuthContext(subject.did);
  const status = restored.rows[0]?.status ?? fallback;
  await auditLog(`${subject.kind}.reverseTakedown`, actorUserId, subject.kind === 'account' ? subject.userId! : subject.did, {
    did: subject.did, restoredStatus: status, tier: subject.tier,
  });
  return status;
}

/** Record that the owner downloaded the repository; the first time, confirm by email with the deletion date. */
export async function markTakedownExported(subject: TakedownSubject): Promise<void> {
  const t = table(subject.kind);
  const first = await query(
    `UPDATE ${t} SET takedown_exported_at = NOW(), exported_at = NOW()
     WHERE did = $1 AND takedown_exported_at IS NULL RETURNING did`, [subject.did]);
  if (first.rows.length === 0 || !subject.deleteAfter) return;
  await notify(subject, `Your ${subject.kind} export is complete — OpenFederation`,
    takedownExportedEmail({ kind: subject.kind, handle: subject.handle, deleteAfter: subject.deleteAfter }));
}

async function deleteSubject(kind: SubjectKind, did: string): Promise<void> {
  if (kind === 'account') {
    const user = (await query<{ id: string }>('SELECT id FROM users WHERE did = $1', [did])).rows[0];
    if (!user) return;
    const blobs = await withTransaction(async (client) => {
      await client.query('DELETE FROM takedown_export_tokens WHERE subject_did = $1', [did]);
      return deleteAccountData(client, { id: user.id, did });
    });
    await removeBlobFiles(blobs);
    invalidateAuthContext(did);
  } else {
    const blobs = await withTransaction(async (client) => {
      await client.query('DELETE FROM takedown_export_tokens WHERE subject_did = $1', [did]);
      return deleteCommunityData(client, did);
    });
    await removeBlobFiles(blobs);
  }
}

/** The daily sweep: reminders 7 days before, and deletion once the deadline has passed. */
export async function sweepTakedowns(): Promise<{ reminded: number; deleted: number }> {
  const result = { reminded: 0, deleted: 0 };
  for (const kind of ['account', 'community'] as const) {
    const t = table(kind);

    const due = await query<{ did: string }>(
      `SELECT did FROM ${t} WHERE status = 'takendown' AND takedown_delete_after IS NOT NULL AND takedown_delete_after <= NOW()`);
    for (const { did } of due.rows) {
      try {
        await deleteSubject(kind, did);
        await auditLog(`${kind}.takedownExpired`, null, did, { did });
        result.deleted++;
      } catch (err) {
        console.error('[takedown] could not delete %s %s:', kind, did, err instanceof Error ? err.message : err);
      }
    }

    const remind = await query<{ did: string }>(
      `UPDATE ${t} SET takedown_reminded_at = NOW()
       WHERE status = 'takendown' AND takedown_tier = 'standard'
         AND takedown_exported_at IS NULL AND takedown_reminded_at IS NULL
         AND takedown_delete_after > NOW() AND takedown_delete_after <= NOW() + INTERVAL '${REMINDER_DAYS_BEFORE} days'
       RETURNING did`);
    for (const { did } of remind.rows) {
      const subject = await findTakedownSubject(did);
      if (!subject?.deleteAfter) continue;
      const link = await issueExportLink(subject, subject.deleteAfter);
      await notify(subject, `Reminder: your ${kind} ${subject.handle} will be deleted — OpenFederation`,
        takedownReminderEmail({ kind, handle: subject.handle, deleteAfter: subject.deleteAfter, exportUrl: link }));
      result.reminded++;
    }
  }
  return result;
}

let timer: ReturnType<typeof setInterval> | null = null;
const CHECK_INTERVAL_MS = 60 * 60 * 1000;

export function startTakedownSweep(): void {
  if (timer) return;
  const check = () => {
    runIfDue('takedown-retention', DAY_MS, async () => {
      const r = await sweepTakedowns();
      if (r.deleted || r.reminded) console.log('[takedown] %d reminder(s) sent, %d repository(ies) deleted', r.reminded, r.deleted);
    }).catch((err) => console.error('[takedown] sweep failed:', err instanceof Error ? err.message : err));
  };
  check();
  timer = setInterval(check, CHECK_INTERVAL_MS);
  timer.unref();
}

export function stopTakedownSweep(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
