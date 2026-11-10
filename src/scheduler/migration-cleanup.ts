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
import { auditLog } from '../db/audit.js';
import { runIfDue } from './schedule.js';
import { homeOf, markCommunityMoved } from '../community/migration.js';
import { deleteAccountData, removeBlobFiles } from '../identity/delete-account.js';
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
    const endpoint = state ? homeOf(state) : null;
    if (!endpoint) continue;
    if (await markCommunityMoved(did, endpoint)) {
      await auditLog('community.moved', null, did, { to: endpoint, by: 'sweep' });
      marked++;
    }
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
    const orphanedBlobs = await withTransaction((client) => deleteAccountData(client, user));
    await removeBlobFiles(orphanedBlobs);
    invalidateAuthContext(user.did);
    result.deleted++;
  }
  return result;
}

let timer: ReturnType<typeof setInterval> | null = null;

/** How often each process checks whether the sweep is due. The sweep's own interval is `MIGRATION_CLEANUP_DAYS`. */
const CHECK_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Run the clean-up sweeps if `MIGRATION_CLEANUP_DAYS` have passed since they
 * last ran on any server. The "two sweeps in a row, days apart" rule that
 * protects a move still in progress depends on that spacing being real: it is
 * kept in the database (see `runIfDue`), not in a per-process timer that
 * restarts with every deploy and exists once per replica.
 */
export async function runMigrationCleanupIfDue(): Promise<void> {
  const days = config.migration.cleanupDays;
  if (days <= 0) return;
  await runIfDue('migration-cleanup', days * 24 * 60 * 60 * 1000, async () => {
    const r = await sweepUnfinishedMigrations();
    if (r.deleted) console.log(`[migration] removed ${r.deleted} unfinished incoming account(s)`);
    const n = await sweepMovedCommunities();
    if (n) console.log(`[migration] marked ${n} community(ies) as moved`);
  });
}

export function startMigrationCleanup(): void {
  if (config.migration.cleanupDays <= 0 || timer) return;
  const check = () => {
    runMigrationCleanupIfDue()
      .catch((err) => console.error('[migration] clean-up sweep failed:', err instanceof Error ? err.message : err));
  };
  check();
  timer = setInterval(check, CHECK_INTERVAL_MS);
  timer.unref();
}

export function stopMigrationCleanup(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
