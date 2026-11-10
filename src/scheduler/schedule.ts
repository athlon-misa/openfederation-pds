import { query, tryWithAdvisoryLock } from '../db/client.js';

export type ScheduledOutcome = 'scheduled' | 'not-due' | 'busy' | 'ran';

/**
 * Run `job` if `intervalMs` has passed since it last ran, anywhere.
 *
 * The time of the last run is a row in `scheduler_runs`, not a timer in this
 * process, and the check-and-run happens under a lock that only one process
 * can hold. So a job runs once per interval however many servers there are,
 * keeps its schedule across restarts, and a slow run is never joined by a
 * second one.
 *
 * The first time a job is seen it is not run: the clock is started, and the
 * first run comes a full interval later. A job that throws is not recorded as
 * run, so the next check tries it again.
 *
 * Call this from a short timer (minutes to an hour). The interval itself can
 * then be any length; it is never handed to `setInterval`, whose delay
 * silently becomes 1 ms above about 24.8 days.
 */
export async function runIfDue(name: string, intervalMs: number, job: () => Promise<void>): Promise<ScheduledOutcome> {
  const attempt = await tryWithAdvisoryLock(`scheduler:${name}`, async (): Promise<ScheduledOutcome> => {
    const row = await query<{ due: boolean }>(
      `SELECT (last_run_at <= CURRENT_TIMESTAMP - ($2::bigint * INTERVAL '1 millisecond')) AS due
       FROM scheduler_runs WHERE name = $1`,
      [name, Math.floor(intervalMs)],
    );
    if (row.rows.length === 0) {
      await query('INSERT INTO scheduler_runs (name) VALUES ($1) ON CONFLICT (name) DO NOTHING', [name]);
      return 'scheduled';
    }
    if (!row.rows[0].due) return 'not-due';
    await job();
    await query('UPDATE scheduler_runs SET last_run_at = CURRENT_TIMESTAMP WHERE name = $1', [name]);
    return 'ran';
  });
  return attempt.ran ? attempt.result : 'busy';
}
