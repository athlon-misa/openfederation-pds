/**
 * Migrations are applied once and remembered. Re-running every file on every
 * boot meant constraint rebuilds under exclusive locks on each restart, data
 * rewritten again by non-idempotent statements, and two replicas racing.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { query } from '../../src/db/client.js';
import { applyMigrations } from '../../src/db/migrate.js';

describe('migration ledger', () => {
  let dir: string;
  const tag = `t${Date.now()}`;
  const first = `migrate-9001-${tag}-counter.sql`;
  const second = `migrate-9002-${tag}-more.sql`;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ledger-'));
    await query(`CREATE TABLE IF NOT EXISTS ledger_test_${tag} (n INT)`);
    writeFileSync(join(dir, first), `INSERT INTO ledger_test_${tag} (n) VALUES (1);`);
  });
  afterAll(async () => {
    await query(`DROP TABLE IF EXISTS ledger_test_${tag}`);
    await query(`DELETE FROM schema_migrations WHERE filename LIKE $1`, [`%${tag}%`]);
    rmSync(dir, { recursive: true, force: true });
  });
  const count = async () => Number((await query<{ c: string }>(`SELECT COUNT(*) AS c FROM ledger_test_${tag}`)).rows[0].c);

  it('applies a migration once, however many times it is asked', async () => {
    expect((await applyMigrations(dir)).applied).toEqual([first]);
    expect((await applyMigrations(dir)).applied).toEqual([]);
    expect(await count()).toBe(1);
  });

  it('applies only what is new', async () => {
    writeFileSync(join(dir, second), `INSERT INTO ledger_test_${tag} (n) VALUES (2);`);
    expect((await applyMigrations(dir)).applied).toEqual([second]);
    expect(await count()).toBe(2);
  });

  it('applies each once when two servers start together', async () => {
    const third = `migrate-9003-${tag}-race.sql`;
    writeFileSync(join(dir, third), `INSERT INTO ledger_test_${tag} (n) VALUES (3);`);
    const runs = await Promise.all([applyMigrations(dir), applyMigrations(dir), applyMigrations(dir)]);
    expect(runs.flatMap(r => r.applied)).toEqual([third]);
    expect(await count()).toBe(3);
  });

  it('records nothing for a migration that fails, so it is retried', async () => {
    const bad = `migrate-9004-${tag}-bad.sql`;
    writeFileSync(join(dir, bad), `INSERT INTO ledger_test_${tag} (n) VALUES (4); SELECT 1/0;`);
    await expect(applyMigrations(dir)).rejects.toThrow();
    expect(await count()).toBe(3);
    const recorded = await query('SELECT 1 FROM schema_migrations WHERE filename = $1', [bad]);
    expect(recorded.rows.length).toBe(0);
    rmSync(join(dir, bad));
  });
});
