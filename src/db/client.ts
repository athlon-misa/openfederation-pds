import { Pool, PoolClient, QueryResult } from 'pg';
import { config } from '../config.js';

let pool: Pool | null = null;

export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      host: config.database.host,
      port: config.database.port,
      database: config.database.database,
      user: config.database.user,
      password: config.database.password,
      max: config.database.maxPoolSize,
      idleTimeoutMillis: config.database.idleTimeoutMs,
      connectionTimeoutMillis: config.database.connectionTimeoutMs,
      statement_timeout: config.database.statementTimeoutMs,
      ssl: config.database.ssl ? { rejectUnauthorized: config.database.sslRejectUnauthorized } : undefined,
    });

    pool.on('error', (err) => {
      console.error('Unexpected error on idle client', err);
    });
  }

  return pool;
}

export async function query<T extends Record<string, any> = any>(
  text: string,
  params?: any[]
): Promise<QueryResult<T>> {
  const pool = getPool();
  return pool.query<T>(text, params);
}

export async function getClient(): Promise<PoolClient> {
  const pool = getPool();
  return pool.connect();
}

/**
 * Run `fn` inside a database transaction. The callback receives the
 * transaction client and may issue any queries on it. Returning a value
 * commits the transaction; throwing rolls it back. The connection is
 * always released, regardless of outcome.
 *
 * Throw a typed error (e.g. `RegistrationValidationError`) from the
 * callback to signal a domain failure — the caller catches it after the
 * rollback has already happened. Do not send HTTP responses from inside
 * the callback; do that at the call site after `withTransaction` returns
 * or rejects.
 */
export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      console.error('Rollback failed after transaction error:', rollbackErr);
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

// Test database connection
export async function testConnection(): Promise<boolean> {
  try {
    const result = await query('SELECT NOW()');
    return true;
  } catch (error) {
    // Only log the connection error message, not the full stack
    if (error instanceof Error) {
      console.error('Database connection failed:', error.message);
    }
    return false;
  }
}
