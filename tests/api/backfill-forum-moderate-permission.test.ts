import { describe, it, expect, beforeAll } from 'vitest';
import { Secp256k1Keypair } from '@atproto/crypto';
import { query } from '../../src/db/client.js';
import { RepoEngine } from '../../src/repo/repo-engine.js';
import { storeSigningKey } from '../../src/identity/manager.js';
import { ROLE_COLLECTION, PERMISSIONS, type RoleRecord } from '../../src/auth/permissions.js';
import { backfillForumModeratePermission } from '../../scripts/backfill-forum-moderate-permission.js';
import { uniqueHandle } from './helpers.js';

/**
 * These tests exercise the backfill script directly against a real signed
 * repo, without going through createTestUser/PLC registration: a did:web
 * identity + RepoEngine.createRepo() is enough to get a real signing
 * keypair and a real MST-backed repo, which is all putRecord needs. This
 * avoids PLC entirely (unlike tests/api/forum-backfill.test.ts, which does
 * need PLC because it goes through the full community.create HTTP flow).
 */

async function makeTestCommunityWithModeratorRole(
  permissions: string[]
): Promise<{ communityDid: string; rkey: string }> {
  const domain = `${uniqueHandle('bf-mod')}.example.com`;
  const communityDid = `did:web:${domain}`;
  const rkey = 'moderator';

  await query(
    `INSERT INTO communities (did, handle, did_method, created_by) VALUES ($1, $2, 'web', NULL)`,
    [communityDid, uniqueHandle('bf-mod-handle')]
  );

  const keypair = await Secp256k1Keypair.create({ exportable: true });
  const exported = await keypair.export();
  await storeSigningKey(communityDid, Buffer.from(exported).toString('base64'));

  const moderatorRole: RoleRecord = {
    name: 'moderator',
    description: 'Community moderator',
    permissions,
  };

  const engine = new RepoEngine(communityDid);
  await engine.createRepo(keypair, [
    { collection: ROLE_COLLECTION, rkey, record: moderatorRole as unknown as Record<string, unknown> },
  ]);

  return { communityDid, rkey };
}

async function fetchRoleRecord(communityDid: string, rkey: string): Promise<RoleRecord> {
  const res = await query<{ record: RoleRecord }>(
    `SELECT record FROM records_index WHERE community_did = $1 AND collection = $2 AND rkey = $3`,
    [communityDid, ROLE_COLLECTION, rkey]
  );
  expect(res.rows).toHaveLength(1);
  return res.rows[0].record;
}

describe('backfillForumModeratePermission', () => {
  let missing: { communityDid: string; rkey: string };
  let already: { communityDid: string; rkey: string };

  beforeAll(async () => {
    // One moderator role WITHOUT the new permission (pre-fix record), one WITH it.
    missing = await makeTestCommunityWithModeratorRole([
      PERMISSIONS.PROFILE_WRITE,
      PERMISSIONS.MEMBER_READ,
      PERMISSIONS.FORUM_WRITE,
    ]);
    already = await makeTestCommunityWithModeratorRole([
      PERMISSIONS.PROFILE_WRITE,
      PERMISSIONS.MEMBER_READ,
      PERMISSIONS.FORUM_WRITE,
      PERMISSIONS.FORUM_MODERATE,
    ]);
  });

  it('dry-run: reports counts but writes nothing', async () => {
    const before = await fetchRoleRecord(missing.communityDid, missing.rkey);
    expect(before.permissions).not.toContain(PERMISSIONS.FORUM_MODERATE);

    const result = await backfillForumModeratePermission({ dryRun: true });

    expect(result.scanned).toBeGreaterThanOrEqual(2);
    expect(result.alreadyHadPermission).toBeGreaterThanOrEqual(1);
    expect(result.updated).toBeGreaterThanOrEqual(1);
    expect(result.failed).toEqual([]);

    // Nothing was actually written — re-fetch fresh from the DB.
    const afterMissing = await fetchRoleRecord(missing.communityDid, missing.rkey);
    expect(afterMissing.permissions).not.toContain(PERMISSIONS.FORUM_MODERATE);
    expect(afterMissing).toEqual(before);

    const afterAlready = await fetchRoleRecord(already.communityDid, already.rkey);
    expect(afterAlready.permissions).toContain(PERMISSIONS.FORUM_MODERATE);
  });

  it('apply: rewrites the missing record via a real signed commit', async () => {
    const result = await backfillForumModeratePermission();

    expect(result.failed).toEqual([]);
    expect(result.updated).toBeGreaterThanOrEqual(1);

    // Re-verify via a FRESH query — don't trust the function's return value.
    const updated = await fetchRoleRecord(missing.communityDid, missing.rkey);
    expect(updated.permissions).toContain(PERMISSIONS.FORUM_MODERATE);
    expect(updated.name).toBe('moderator');

    // The already-correct record is untouched.
    const untouched = await fetchRoleRecord(already.communityDid, already.rkey);
    expect(untouched.permissions).toContain(PERMISSIONS.FORUM_MODERATE);
  });

  it('idempotency: a second real run is a no-op', async () => {
    const first = await backfillForumModeratePermission();
    expect(first.updated).toBe(0);
    expect(first.failed).toEqual([]);
    expect(first.alreadyHadPermission).toBeGreaterThanOrEqual(2);

    const beforeSecond = await fetchRoleRecord(missing.communityDid, missing.rkey);

    const second = await backfillForumModeratePermission();
    expect(second.updated).toBe(0);
    expect(second.failed).toEqual([]);

    const afterSecond = await fetchRoleRecord(missing.communityDid, missing.rkey);
    expect(afterSecond).toEqual(beforeSecond);
  });
});
