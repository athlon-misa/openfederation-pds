/**
 * The setup wizard's database access, before the server's configuration (and
 * so src/db/client.ts) exists. It connects with the same DB_* variables.
 */
import { Pool } from 'pg';

type Env = Record<string, string | undefined>;

/** Identical to scripts/migrate-060-server-setup.sql. */
export const SERVER_SETUP_DDL = `CREATE TABLE IF NOT EXISTS server_setup (
  id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  completed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  config_file TEXT NOT NULL,
  pending_admin_handle TEXT,
  pending_admin_email TEXT,
  pending_admin_password_hash TEXT
)`;

export function createSetupPool(env: Env): Pool {
  const pool = new Pool({
    host: env.DB_HOST || 'localhost',
    port: parseInt(env.DB_PORT || '5432', 10),
    database: env.DB_NAME || 'openfederation_pds',
    user: env.DB_USER || 'postgres',
    password: env.DB_PASSWORD || '',
    max: 2,
    connectionTimeoutMillis: 5000,
    ssl: env.DB_SSL === 'true' ? { rejectUnauthorized: env.DB_SSL_REJECT_UNAUTHORIZED !== 'false' } : undefined,
  });
  pool.on('error', (err) => console.error('Setup: unexpected database error', err.message));
  return pool;
}

export interface SetupStore {
  /** Whether the database answers at all. */
  reachable(): Promise<boolean>;
  /** When setup was finished, if it was. */
  completedAt(): Promise<Date | null>;
  /**
   * Record that setup is finished, with the first admin waiting to be
   * created, then run `persist` (which writes the settings file) before
   * committing. If `persist` throws, nothing is recorded; if the commit
   * fails, `undo` removes what `persist` wrote.
   */
  complete(record: { configFile: string; admin: { handle: string; email: string; passwordHash: string } }, persist: () => void, undo: () => void): Promise<void>;
  /** Whether a user already has this handle or email (a database restored into a fresh install). */
  accountExists(handle: string, email: string): Promise<boolean>;
}

export function createSetupStore(pool: Pool): SetupStore {
  return {
    async reachable() {
      try {
        await pool.query('SELECT 1');
        return true;
      } catch {
        return false;
      }
    },
    async completedAt() {
      const exists = await pool.query<{ t: string | null }>("SELECT to_regclass('public.server_setup')::text AS t");
      if (!exists.rows[0]?.t) return null;
      const row = await pool.query<{ completed_at: Date }>('SELECT completed_at FROM server_setup WHERE id');
      return row.rows[0]?.completed_at ?? null;
    },
    async accountExists(handle, email) {
      const exists = await pool.query<{ t: string | null }>("SELECT to_regclass('public.users')::text AS t");
      if (!exists.rows[0]?.t) return false;
      const r = await pool.query('SELECT 1 FROM users WHERE handle = $1 OR email = $2 LIMIT 1', [handle, email]);
      return (r.rowCount ?? 0) > 0;
    },
    async complete(record, persist, undo) {
      const client = await pool.connect();
      let persisted = false;
      try {
        await client.query('BEGIN');
        await client.query(SERVER_SETUP_DDL);
        // Fails on the primary key if setup was already finished, even by
        // another instance at the same moment.
        await client.query(
          `INSERT INTO server_setup (id, config_file, pending_admin_handle, pending_admin_email, pending_admin_password_hash)
           VALUES (TRUE, $1, $2, $3, $4)`,
          [record.configFile, record.admin.handle, record.admin.email, record.admin.passwordHash],
        );
        persist();
        persisted = true;
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        if (persisted) undo();
        throw err;
      } finally {
        client.release();
      }
    },
  };
}
