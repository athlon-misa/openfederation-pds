/**
 * Clean-up of accounts that started moving here and never finished (#265).
 *
 * Only a copy that was never activated here (migrating_in) is ever removed,
 * and only when its DID names another PDS on two sweeps in a row. The DID
 * says where the real account lives, so removing such a copy loses nothing.
 * A copy left behind by a move away from here is never touched: it stays as
 * a backup until its owner deletes it. Nothing is deleted while the DID
 * points here, and nothing happens when the PLC directory cannot be reached.
 *
 * Sweeps run MIGRATION_CLEANUP_DAYS apart and never at start-up, so a copy
 * is at least that old before it goes. The only state kept is a flag: no
 * timestamp ever says when a pseudonym was seen.
 */
import { config } from '../config.js';
import { query, withTransaction } from '../db/client.js';
import { currentPlcState } from '../identity/account-migration.js';
import { deleteAccountData } from '../identity/delete-account.js';
import { invalidateAuthContext } from '../auth/auth-context-cache.js';

/** Communities whose DID now names another PDS are marked moved (#267); nothing is deleted. */
export async function sweepMovedCommunities(): Promise<number> {
  let marked = 0;
  const rows = (await query<{ did: string }>(`SELECT did FROM communities WHERE status = 'active' AND did_method = 'plc'`)).rows;
  for (const { did } of rows) {
    let state;
    try {
      state = await currentPlcState(did);
    } catch {
      return marked;
    }
    const endpoint = state?.services.atproto_pds?.endpoint;
    if (!state || !endpoint || endpoint === config.pds.serviceUrl) continue;
    await query(`UPDATE communities SET status = 'moved', status_changed_at = CURRENT_TIMESTAMP, status_reason = $2 WHERE did = $1 AND status = 'active'`, [did, `moved to ${endpoint}`]);
    marked++;
  }
  return marked;
}

export async function sweepUnfinishedMigrations(): Promise<{ flagged: number; deleted: number }> {
  const result = { flagged: 0, deleted: 0 };
  const rows = (await query<{ id: string; did: string; seen_elsewhere: boolean }>(
    `SELECT id, did, seen_elsewhere FROM users WHERE migrating_in AND status = 'deactivated'`)).rows;
  for (const user of rows) {
    let state;
    try {
      state = await currentPlcState(user.did);
    } catch {
      return result; // The directory is unreachable: decide nothing this time.
    }
    const elsewhere = !!state && state.services.atproto_pds?.endpoint !== config.pds.serviceUrl;
    if (!elsewhere) {
      if (user.seen_elsewhere) await query('UPDATE users SET seen_elsewhere = false WHERE id = $1', [user.id]);
      continue;
    }
    if (!user.seen_elsewhere) {
      await query('UPDATE users SET seen_elsewhere = true WHERE id = $1', [user.id]);
      result.flagged++;
      continue;
    }
    await withTransaction((client) => deleteAccountData(client, user));
    invalidateAuthContext(user.did);
    result.deleted++;
  }
  return result;
}

let timer: ReturnType<typeof setInterval> | null = null;

export function startMigrationCleanup(): void {
  const days = config.migration.cleanupDays;
  if (days <= 0 || timer) return;
  timer = setInterval(() => {
    sweepUnfinishedMigrations()
      .then((r) => { if (r.deleted) console.log(`[migration] removed ${r.deleted} unfinished incoming account(s)`); })
      .then(() => sweepMovedCommunities())
      .then((n) => { if (n) console.log(`[migration] marked ${n} community(ies) as moved`); })
      .catch((err) => console.error('[migration] clean-up sweep failed:', err instanceof Error ? err.message : err));
  }, days * 24 * 60 * 60 * 1000);
  timer.unref();
}

export function stopMigrationCleanup(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
