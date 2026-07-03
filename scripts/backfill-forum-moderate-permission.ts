import { query } from '../src/db/client.js';
import { RepoEngine } from '../src/repo/repo-engine.js';
import { getKeypairForDid } from '../src/repo/keypair-utils.js';
import { ROLE_COLLECTION, PERMISSIONS, type RoleRecord } from '../src/auth/permissions.js';

export interface BackfillResult {
  scanned: number;
  alreadyHadPermission: number;
  updated: number;
  failed: Array<{ communityDid: string; rkey: string; error: string }>;
}

interface ModeratorRoleRow {
  community_did: string;
  rkey: string;
  record: RoleRecord;
}

/**
 * Backfills the `community.forum.moderate` permission onto every existing
 * `moderator` role record. Task A (already committed) added this permission
 * to the default moderator role definition for newly created communities,
 * but communities created before that fix already have a signed
 * `net.openfederation.community.role` record for 'moderator' that lacks it.
 *
 * `records_index` is a read projection of the signed AT-proto repo record —
 * updating it directly would desync the record from its signed commit. So
 * this mirrors the write mechanism used by `updateRole.ts`: RepoEngine +
 * getKeypairForDid + putRecord, producing a new signed commit per community.
 */
export async function backfillForumModeratePermission(
  opts?: { dryRun?: boolean }
): Promise<BackfillResult> {
  const dryRun = opts?.dryRun ?? false;

  const result: BackfillResult = {
    scanned: 0,
    alreadyHadPermission: 0,
    updated: 0,
    failed: [],
  };

  const rows = await query<ModeratorRoleRow>(
    `SELECT community_did, rkey, record FROM records_index
     WHERE collection = $1 AND record->>'name' = 'moderator'`,
    [ROLE_COLLECTION]
  );

  for (const row of rows.rows) {
    result.scanned++;
    const currentRole = row.record;
    const permissions = Array.isArray(currentRole.permissions) ? currentRole.permissions : [];

    if (permissions.includes(PERMISSIONS.FORUM_MODERATE)) {
      result.alreadyHadPermission++;
      continue;
    }

    if (dryRun) {
      // Report-only: count what WOULD be updated, but make no writes.
      result.updated++;
      console.log(`[dry-run] would add ${PERMISSIONS.FORUM_MODERATE} to moderator role for ${row.community_did} (rkey=${row.rkey})`);
      continue;
    }

    try {
      const updatedRecord: RoleRecord = {
        ...currentRole,
        permissions: [...permissions, PERMISSIONS.FORUM_MODERATE],
      };

      const engine = new RepoEngine(row.community_did);
      const keypair = await getKeypairForDid(row.community_did);
      await engine.putRecord(keypair, ROLE_COLLECTION, row.rkey, updatedRecord);

      result.updated++;
      console.log(`Updated moderator role for ${row.community_did} (rkey=${row.rkey})`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.failed.push({ communityDid: row.community_did, rkey: row.rkey, error: message });
      console.error(`Failed to update moderator role for ${row.community_did} (rkey=${row.rkey}):`, message);
    }
  }

  return result;
}

// Allow running directly: `npx tsx scripts/backfill-forum-moderate-permission.ts [--dry-run]`
if (import.meta.url === `file://${process.argv[1]}`) {
  const dryRun = process.argv.includes('--dry-run');
  backfillForumModeratePermission({ dryRun })
    .then((r) => {
      console.log(dryRun ? 'DRY RUN — nothing written.' : 'Backfill complete:', r);
      process.exit(0);
    })
    .catch((err) => {
      console.error('Backfill failed:', err);
      process.exit(1);
    });
}
