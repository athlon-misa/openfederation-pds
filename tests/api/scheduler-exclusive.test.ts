/**
 * Background jobs run on a persisted schedule, one runner at a time, however
 * many server processes there are and however often they restart.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { query, tryWithAdvisoryLock } from '../../src/db/client.js';
import { runIfDue } from '../../src/scheduler/schedule.js';

const JOB = `test-job-${Date.now()}`;
const DAY = 24 * 60 * 60 * 1000;

describe('scheduled jobs', () => {
  beforeEach(async () => { await query('DELETE FROM scheduler_runs WHERE name = $1', [JOB]); });

  it('does not run on first sight; it starts the clock', async () => {
    let runs = 0;
    expect(await runIfDue(JOB, 7 * DAY, async () => { runs++; })).toBe('scheduled');
    expect(runs).toBe(0);
    expect(await runIfDue(JOB, 7 * DAY, async () => { runs++; })).toBe('not-due');
    expect(runs).toBe(0);
  });

  it('runs once the interval has passed, then waits a full interval again', async () => {
    let runs = 0;
    await runIfDue(JOB, 7 * DAY, async () => { runs++; });
    await query(`UPDATE scheduler_runs SET last_run_at = CURRENT_TIMESTAMP - INTERVAL '8 days' WHERE name = $1`, [JOB]);
    expect(await runIfDue(JOB, 7 * DAY, async () => { runs++; })).toBe('ran');
    expect(await runIfDue(JOB, 7 * DAY, async () => { runs++; })).toBe('not-due');
    expect(runs).toBe(1);
  });

  it('runs once when several processes notice it is due at the same moment', async () => {
    let runs = 0;
    await runIfDue(JOB, 7 * DAY, async () => undefined);
    await query(`UPDATE scheduler_runs SET last_run_at = CURRENT_TIMESTAMP - INTERVAL '8 days' WHERE name = $1`, [JOB]);
    const slow = async () => { runs++; await new Promise((r) => setTimeout(r, 150)); };
    const outcomes = await Promise.all([runIfDue(JOB, 7 * DAY, slow), runIfDue(JOB, 7 * DAY, slow), runIfDue(JOB, 7 * DAY, slow)]);
    expect(runs).toBe(1);
    expect(outcomes.filter((o) => o === 'ran')).toHaveLength(1);
  });

  it('a failed run is not recorded, so it is tried again', async () => {
    await runIfDue(JOB, 7 * DAY, async () => undefined);
    await query(`UPDATE scheduler_runs SET last_run_at = CURRENT_TIMESTAMP - INTERVAL '8 days' WHERE name = $1`, [JOB]);
    await expect(runIfDue(JOB, 7 * DAY, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    let runs = 0;
    expect(await runIfDue(JOB, 7 * DAY, async () => { runs++; })).toBe('ran');
    expect(runs).toBe(1);
  });

  it('tryWithAdvisoryLock skips instead of waiting when the lock is held', async () => {
    let inner: { ran: boolean } | undefined;
    const outer = await tryWithAdvisoryLock(`lock-${JOB}`, async () => {
      inner = await tryWithAdvisoryLock(`lock-${JOB}`, async () => 'second');
      return 'first';
    });
    expect(outer).toEqual({ ran: true, result: 'first' });
    expect(inner).toEqual({ ran: false });
  });
});
