#!/usr/bin/env node
/**
 * Migration script: Convert existing records_index-only repos to real MST repos.
 *
 * For each community in the `communities` table:
 * 1. Load all records from `records_index`
 * 2. Load the signing keypair
 * 3. Create a real MST repo via RepoEngine.createRepo()
 * 4. Verify the repo was created correctly
 *
 * Usage:
 *   npx tsx scripts/migrate-to-mst.ts
 *   # or after build:
 *   node dist/scripts/migrate-to-mst.js
 */

import 'dotenv/config';
import { query, closePool } from '../src/db/client.js';
import { RepoEngine } from '../src/repo/repo-engine.js';
import { getKeypairForDid } from '../src/repo/keypair-utils.js';

interface CommunityRow {
  did: string;
  handle: string;
}

interface RecordRow {
  collection: string;
  rkey: string;
  record: Record<string, unknown>;
}

async function main() {
  console.log('=== MST Migration: records_index → real AT Protocol repos ===\n');

  // Check if repo_roots table exists
  try {
    await query('SELECT 1 FROM repo_roots LIMIT 1');
  } catch {
    console.error('ERROR: repo_roots table does not exist.');
    console.error('Run the migration first: psql -f scripts/migrate-001-repo-roots.sql');
    process.exit(1);
  }

  // Get all communities
  const communities = await query<CommunityRow>(
    'SELECT did, handle FROM communities ORDER BY created_at'
  );

  console.log(`Found ${communities.rows.length} communities to migrate.\n`);

  let success = 0;
  let skipped = 0;
  let failed = 0;

  for (const community of communities.rows) {
    const { did, handle } = community;

    try {
      // Check if repo already exists
      const engine = new RepoEngine(did);
      if (await engine.hasRepo()) {
        console.log(`  SKIP: ${handle} (${did}) — repo already exists`);
        skipped++;
        continue;
      }

      // Load keypair
      let keypair;
      try {
        keypair = await getKeypairForDid(did);
      } catch (err) {
        console.log(`  SKIP: ${handle} (${did}) — no signing key found`);
        skipped++;
        continue;
      }

      // Load all records from records_index
      const records = await query<RecordRow>(
        'SELECT collection, rkey, record FROM records_index WHERE community_did = $1 ORDER BY collection, rkey',
        [did]
      );

      if (records.rows.length === 0) {
        console.log(`  SKIP: ${handle} (${did}) — no records to migrate`);
        skipped++;
        continue;
      }

      const initialRecords = records.rows.map(r => ({
        collection: r.collection,
        rkey: r.rkey,
        record: r.record,
      }));

      // Create real MST repo
      await engine.createRepo(keypair, initialRecords);

      // Verify
      const hasRepo = await engine.hasRepo();
      if (!hasRepo) {
        throw new Error('Repo creation succeeded but hasRepo() returns false');
      }

      console.log(`  OK: ${handle} (${did}) — ${records.rows.length} records migrated`);
      success++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`  FAIL: ${handle} (${did}) — ${message}`);
      failed++;
    }
  }

  console.log('\n=== Migration Summary ===');
  console.log(`  Success: ${success}`);
  console.log(`  Skipped: ${skipped}`);
  console.log(`  Failed:  ${failed}`);
  console.log(`  Total:   ${communities.rows.length}`);

  await closePool();

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
