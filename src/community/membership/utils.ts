import type { AuthContext } from '../../auth/types.js';
import { query } from '../../db/client.js';
import { MEMBER_COLLECTION, findRoleRkeyByName } from '../../auth/permissions.js';
import { RepoEngine } from '../../repo/repo-engine.js';
import { getKeypairForDid } from '../../repo/keypair-utils.js';
import { throwXrpc } from '../../xrpc/errors.js';
import { resolveDisplayFields } from '../display-projection.js';

export function requireString(value: unknown, nsid: string, message: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throwXrpc(nsid, 'InvalidRequest', 400, message);
  }
  return value;
}

export async function ensureCommunityExists(communityDid: string): Promise<void> {
  const JOIN_NSID = 'net.openfederation.community.join';
  const communityResult = await query<{ did: string }>(
    'SELECT did FROM communities WHERE did = $1',
    [communityDid],
  );
  if (communityResult.rows.length === 0) {
    throwXrpc(JOIN_NSID, 'NotFound', 404, 'Community not found');
  }
}

export async function getCommunityOwner(communityDid: string, nsid: string): Promise<{ created_by: string }> {
  const communityResult = await query<{ created_by: string }>(
    'SELECT created_by FROM communities WHERE did = $1',
    [communityDid],
  );
  if (communityResult.rows.length === 0) {
    throwXrpc(nsid, 'NotFound', 404, 'Community not found');
  }
  return communityResult.rows[0];
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
