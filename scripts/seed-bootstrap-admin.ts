#!/usr/bin/env node
/**
 * Seed the bootstrap admin user into the database.
 * Used by CI to reliably create the admin before integration tests,
 * without starting the full Express server.
 */

import { ensureBootstrapAdmin } from '../src/auth/bootstrap.js';
import { closePool } from '../src/db/client.js';

try {
  await ensureBootstrapAdmin();
  console.log('✓ Bootstrap admin seeded');
} catch (err) {
  console.error('✗ Failed to seed bootstrap admin:', err);
  process.exit(1);
} finally {
  await closePool();
}
