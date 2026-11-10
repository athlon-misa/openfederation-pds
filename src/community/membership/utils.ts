import type { AuthContext } from '../../auth/types.js';
import { query } from '../../db/client.js';
import { MEMBER_COLLECTION, findRoleRkeyByName } from '../../auth/permissions.js';
import { RepoEngine } from '../../repo/repo-engine.js';
import { getKeypairForDid } from '../../repo/keypair-utils.js';
import { throwXrpc } from '../../xrpc/errors.js';
import { resolveDisplayFields } from '../display-projection.js';
import { communityWriteRefusal } from '../../auth/guards.js';

export function requireString(value: unknown, nsid: string, message: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throwXrpc(nsid, 'InvalidRequest', 400, message);
  }
  return value;
}

/**
 * The community must exist and accept writes. Membership changes are commits
 * to the community's repo, so they stop when it is suspended or taken down,
 * and on a copy that moved away or has not finished arriving.
 */
export async function ensureCommunityWritable(communityDid: string, nsid: string): Promise<void> {
  const communityResult = await query<{ status: string }>(
    'SELECT status FROM communities WHERE did = $1',
    [communityDid],
  );
  if (communityResult.rows.length === 0) {
    throwXrpc(nsid, 'NotFound', 404, 'Community not found');
  }
  const refusal = communityWriteRefusal(communityResult.rows[0].status);
  if (refusal) throwXrpc(nsid, refusal.error, refusal.status, refusal.message);
}

/**
 * Who owns the community, by DID. `owner_did` is the record of ownership: the
 * owner may live on another PDS, and a community that moved here has no local
 * creator (`created_by` is NULL). `created_by` is only a fallback for rows
 * written before `owner_did` existed.
 *
 * `ownerRoleRkey` is the role the owner's member record points at, which is
 * what makes a role "the owner role" whatever it is currently named.
 */
export async function getCommunityOwner(
  communityDid: string,
  nsid: string,
): Promise<{ ownerDid: string | null; ownerRoleRkey: string | null }> {
  const communityResult = await query<{ owner_did: string | null; owner_role_rkey: string | null }>(
    `SELECT COALESCE(c.owner_did, u.did) AS owner_did,
            (SELECT m.role_rkey FROM members_unique m
              WHERE m.community_did = c.did AND m.member_did = COALESCE(c.owner_did, u.did)) AS owner_role_rkey
     FROM communities c
     LEFT JOIN users u ON u.id = c.created_by
     WHERE c.did = $1`,
    [communityDid],
  );
  if (communityResult.rows.length === 0) {
    throwXrpc(nsid, 'NotFound', 404, 'Community not found');
  }
  return {
    ownerDid: communityResult.rows[0].owner_did,
    ownerRoleRkey: communityResult.rows[0].owner_role_rkey,
  };
}

export async function ensureNotAlreadyMember(communityDid: string, memberDid: string): Promise<void> {
  const JOIN_NSID = 'net.openfederation.community.join';
  const memberCheck = await query(
    'SELECT 1 FROM members_unique WHERE community_did = $1 AND member_did = $2',
    [communityDid, memberDid],
  );
  if (memberCheck.rows.length > 0) {
    throwXrpc(JOIN_NSID, 'AlreadyMember', 409, 'You are already a member of this community');
  }
}

export async function getMemberRkey(communityDid: string, memberDid: string): Promise<string | null> {
  const memberResult = await query<{ record_rkey: string }>(
    'SELECT record_rkey FROM members_unique WHERE community_did = $1 AND member_did = $2',
    [communityDid, memberDid],
  );
  return memberResult.rows[0]?.record_rkey || null;
}

export async function deleteMemberRecord(communityDid: string, rkey: string): Promise<void> {
  const engine = new RepoEngine(communityDid);
  const keypair = await getKeypairForDid(communityDid);
  await engine.deleteRecord(keypair, MEMBER_COLLECTION, rkey);
}

export async function getUserDid(userId: string): Promise<string | null> {
  const result = await query<{ did: string }>(
    'SELECT did FROM users WHERE id = $1',
    [userId],
  );
  return result.rows[0]?.did || null;
}

export async function getUserIdByDid(did: string): Promise<string | null> {
  const result = await query<{ id: string }>(
    'SELECT id FROM users WHERE did = $1',
    [did],
  );
  return result.rows[0]?.id || null;
}

export async function getUserHandle(userId: string): Promise<string | null> {
  const result = await query<{ handle: string }>(
    'SELECT handle FROM users WHERE id = $1',
    [userId],
  );
  return result.rows[0]?.handle || null;
}

export async function getJoinPolicy(communityDid: string): Promise<string> {
  const settingsResult = await query<{ record: { joinPolicy?: string } }>(
    `SELECT record FROM records_index
     WHERE community_did = $1 AND collection = 'net.openfederation.community.settings' AND rkey = 'self'`,
    [communityDid],
  );
  return settingsResult.rows[0]?.record?.joinPolicy || 'open';
}

export async function createMemberRecord(
  communityDid: string,
  caller: AuthContext,
  semantic: { kind?: string; tags?: string[]; attributes?: Record<string, unknown> },
): Promise<void> {
  return createMemberRecordForDid(communityDid, caller.did, caller.handle, semantic);
}

export async function createMemberRecordForDid(
  communityDid: string,
  memberDid: string,
  handle: string,
  semantic: { kind?: string; tags?: string[]; attributes?: Record<string, unknown> },
): Promise<void> {
  const engine = new RepoEngine(communityDid);
  const keypair = await getKeypairForDid(communityDid);
  const rkey = RepoEngine.generateTid();
  const memberRoleRkey = await findRoleRkeyByName(communityDid, 'member', query);
  const role = memberRoleRkey ? undefined : 'member';
  const memberRecord: Record<string, unknown> = {
    did: memberDid,
    handle,
    ...(memberRoleRkey ? { roleRkey: memberRoleRkey } : { role }),
    joinedAt: new Date().toISOString(),
  };
  if (semantic.kind) memberRecord.kind = semantic.kind;
  if (semantic.tags && semantic.tags.length > 0) memberRecord.tags = semantic.tags;
  if (semantic.attributes && Object.keys(semantic.attributes).length > 0) {
    memberRecord.attributes = semantic.attributes;
  }

  await engine.putRecord(keypair, MEMBER_COLLECTION, rkey, memberRecord);

  // Resolve display fields and sync to the projection row that putRecord
  // created in members_unique via the repo write path.
  const display = await resolveDisplayFields(memberDid, handle);
  await query(
    `UPDATE members_unique
     SET display_name = $1,
         avatar_url   = $2,
         role         = $3,
         role_rkey    = $4,
         kind         = $5,
         tags         = $6,
         attributes   = $7
     WHERE community_did = $8 AND member_did = $9`,
    [
      display.displayName,
      display.avatarUrl,
      role ?? null,
      memberRoleRkey ?? null,
      semantic.kind ?? null,
      semantic.tags?.length ? JSON.stringify(semantic.tags) : null,
      semantic.attributes && Object.keys(semantic.attributes).length
        ? JSON.stringify(semantic.attributes)
        : null,
      communityDid,
      memberDid,
    ],
  );
}
