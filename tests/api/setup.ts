// Test environment setup — runs before all integration tests
//
// TEST_DB_NAME is REQUIRED and must differ from DB_NAME. Tests delete and
// mutate users, sessions, communities, and other tables, so running against
// the dev database would destroy local data.

process.env.NODE_ENV = 'test';

if (!process.env.TEST_DB_NAME) {
  throw new Error(
    'TEST_DB_NAME is required for integration tests. Set it to a dedicated ' +
    'test database (e.g., openfederation_pds_test) in your .env or test runner. ' +
    'Tests mutate and delete data; running against the dev database would destroy it.'
  );
}
if (process.env.TEST_DB_NAME === process.env.DB_NAME) {
  throw new Error(
    `TEST_DB_NAME (${process.env.TEST_DB_NAME}) must differ from DB_NAME ` +
    `(${process.env.DB_NAME}) to prevent dev data corruption.`
  );
}
process.env.DB_NAME = process.env.TEST_DB_NAME;

// Ensure secrets are set (in case .env is missing)
process.env.AUTH_JWT_SECRET = process.env.AUTH_JWT_SECRET || 'test-jwt-secret-that-is-at-least-32-characters-long-for-testing';
process.env.KEY_ENCRYPTION_SECRET = process.env.KEY_ENCRYPTION_SECRET || 'test-key-encryption-secret-at-least-32-chars';
process.env.PLC_DIRECTORY_URL = process.env.PLC_DIRECTORY_URL || 'http://localhost:2582';

// Initialize the test database schema before any test code runs. Applies
// src/db/schema.sql + all scripts/migrate-*.sql in filename order. Safe to
// re-run: schema.sql uses CREATE IF NOT EXISTS, and each migration script
// is expected to be idempotent.
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { Pool } from 'pg';

await (async () => {
  const pool = new Pool({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    database: process.env.DB_NAME,
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || '',
  });
  try {
    // Skip schema + migrations if the database is already initialized.
    // schema.sql and some migrations use CREATE (not CREATE IF NOT EXISTS)
    // for indexes, so re-applying them errors on a populated database.
    const check = await pool.query<{ exists: boolean }>(
      "SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'users') AS exists",
    );
    if (check.rows[0]?.exists) return;

    const schemaPath = join(process.cwd(), 'src', 'db', 'schema.sql');
    if (existsSync(schemaPath)) {
      await pool.query(readFileSync(schemaPath, 'utf-8'));
    }
    const migrationsDir = join(process.cwd(), 'scripts');
    const migrations = readdirSync(migrationsDir)
      .filter((f) => /^migrate-\d+.*\.sql$/.test(f))
      .sort();
    for (const m of migrations) {
      try {
        await pool.query(readFileSync(join(migrationsDir, m), 'utf-8'));
      } catch (err) {
        // Migrations are written to be idempotent but some CREATE operations
        // may error on repeat runs. Surface only unexpected failures.
        const msg = err instanceof Error ? err.message : String(err);
        if (!/already exists|duplicate/i.test(msg)) {
          console.error(`[test-setup] migration ${m} failed:`, msg);
        }
      }
    }
  } finally {
    await pool.end();
  }
})();

// Raise rate limits in tests so accumulated in-memory state across many
// test cases (the app is a long-lived singleton inside vitest) doesn't
// cause spurious 429s. Only applied when not already explicitly set.
process.env.AUTH_RATE_LIMIT = process.env.AUTH_RATE_LIMIT || '10000';
process.env.REGISTRATION_RATE_LIMIT = process.env.REGISTRATION_RATE_LIMIT || '10000';
process.env.CREATE_RATE_LIMIT = process.env.CREATE_RATE_LIMIT || '10000';
process.env.WALLET_SIGN_RATE_LIMIT = process.env.WALLET_SIGN_RATE_LIMIT || '10000';

// Seed the bootstrap admin. Tests that import `app` don't call main(),
// so ensureBootstrapAdmin never runs normally — we do it once here.
process.env.BOOTSTRAP_ADMIN_HANDLE = process.env.BOOTSTRAP_ADMIN_HANDLE || 'admin';
process.env.BOOTSTRAP_ADMIN_EMAIL = process.env.BOOTSTRAP_ADMIN_EMAIL || 'admin@test.local';
process.env.BOOTSTRAP_ADMIN_PASSWORD = process.env.BOOTSTRAP_ADMIN_PASSWORD || 'AdminPass1234';
const { ensureBootstrapAdmin } = await import('../../src/auth/bootstrap.js');
await ensureBootstrapAdmin();
