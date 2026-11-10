import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { getClient } from './client.js';

/** Arbitrary constant: the advisory lock every server takes while migrating. */
const MIGRATION_LOCK_KEY = 0x0f_ed_5c_4e;

/**
 * Apply the `migrate-NNN-*.sql` files in `dir` that this database has not had
 * yet, in filename order, and remember each one in `schema_migrations`.
 *
 * Every file used to be re-run on every start. They were written to tolerate
 * that, but "tolerates" is not "free": several drop and re-add constraints,
 * re-validating whole tables under an exclusive lock on each boot; one
 * re-granted roles an admin had deliberately removed; one rewrote timestamp
 * columns again each time; and two replicas starting together ran the same
 * DDL concurrently. Applied once, none of that happens.
 *
 * A session advisory lock makes servers starting together take turns: the
 * second waits, then finds everything already recorded.
 *
 * A database that predates the ledger has an empty one, so the first start
 * after this change runs every file one last time (exactly what every start
 * did before) and records them.
 *
 * A file is recorded only after it ran without error. One that fails stops the
 * run and is tried again on the next start.
 */
export async function applyMigrations(dir: string): Promise<{ applied: string[]; skipped: number }> {
  if (!existsSync(dir)) return { applied: [], skipped: 0 };
  const files = readdirSync(dir).filter((f) => /^migrate-\d+.*\.sql$/.test(f)).sort();
  if (files.length === 0) return { applied: [], skipped: 0 };

  const client = await getClient();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    // Migrations may build indexes or backfill; the pool's per-statement
    // timeout is tuned for requests, not for those.
    await client.query('SET statement_timeout = 0');
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         filename TEXT PRIMARY KEY,
         applied_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
       )`,
    );
    const done = new Set(
      (await client.query<{ filename: string }>('SELECT filename FROM schema_migrations')).rows.map((r) => r.filename),
    );

    const applied: string[] = [];
    for (const file of files) {
      if (done.has(file)) continue;
      try {
        // Sent as one multi-statement query, which Postgres runs as a single
        // implicit transaction unless the file manages its own.
        await client.query(readFileSync(join(dir, file), 'utf-8'));
      } catch (err) {
        // A file with its own BEGIN leaves the session mid-transaction on error.
        await client.query('ROLLBACK').catch(() => undefined);
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`Migration ${file} failed: ${msg}`);
        throw err;
      }
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING', [file]);
      applied.push(file);
    }
    return { applied, skipped: files.length - applied.length };
  } finally {
    await client.query('RESET statement_timeout').catch(() => undefined);
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => undefined);
    client.release();
  }
}
