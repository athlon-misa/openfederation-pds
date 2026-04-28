import { randomUUID } from 'crypto';
import type { AuthContext } from '../auth/types.js';
import { query } from '../db/client.js';
import { MEMBER_COLLECTION, ROLE_COLLECTION, findRoleRkeyByName } from '../auth/permissions.js';
import { RepoEngine } from '../repo/repo-engine.js';
import { getKeypairForDid } from '../repo/keypair-utils.js';
import { throwXrpc } from '../xrpc/errors.js';
import { auditLog } from '../db/audit.js';
import { getCallerCommunityCapabilities } from './visibility.js';

const JOIN_NSID = 'net.openfederation.community.join';
const LEAVE_NSID = 'net.openfederation.community.leave';
const REMOVE_NSID = 'net.openfederation.community.removeMember';
const RESOLVE_JOIN_REQUEST_NSID = 'net.openfederation.community.resolveJoinRequest';
const UPDATE_MEMBER_NSID = 'net.openfederation.community.updateMember';
const MAX_KIND_LENGTH = 64;
const MAX_TAGS = 20;
const MAX_TAG_LENGTH = 64;
const MAX_ATTRIBUTES_SIZE = 4096;

export interface JoinCommunityInput {
  did?: unknown;
  kind?: unknown;
  tags?: unknown;
  attributes?: unknown;
}

export type JoinCommunityResult = {
  status: 'joined' | 'pending';
};

export interface LeaveCommunityInput {
  did?: unknown;
}

export interface RemoveMemberInput {
  did?: unknown;
  memberDid?: unknown;
}

export interface ResolveJoinRequestInput {
  requestId?: unknown;
  action?: unknown;
}

export interface UpdateMemberInput {
  communityDid?: unknown;
  memberDid?: unknown;
  role?: unknown;
  roleRkey?: unknown;
  kind?: unknown;
  tags?: unknown;
  attributes?: unknown;
}

export interface UpdateMemberResult {
  uri: string;
  cid: string;
  role?: string;
  roleRkey?: string;
  kind?: string;
  tags?: string[];
  attributes?: Record<string, unknown>;
}

type MemberRecord = {
  did: string;
  handle: string;
  joinedAt: string;
  role?: string;
  roleRkey?: string;
  kind?: string;
  tags?: string[];
  attributes?: Record<string, unknown>;
};

export async function joinCommunityLifecycle(
  caller: AuthContext,
  input: JoinCommunityInput,
): Promise<JoinCommunityResult> {
  const { did, kind, tags, attributes } = validateJoinInput(input);

  await ensureCommunityExists(did);
  await ensureNotAlreadyMember(did, caller.did);

  const joinPolicy = await getJoinPolicy(did);
  if (joinPolicy === 'open') {
    await createMemberRecord(did, caller, { kind, tags, attributes });
    return { status: 'joined' };
  }

  const existingRequest = await query<{ status: string }>(
    'SELECT status FROM join_requests WHERE community_did = $1 AND user_id = $2',
    [did, caller.userId],
  );

  if (existingRequest.rows.length > 0) {
    const status = existingRequest.rows[0].status;
    if (status === 'pending') {
      throwXrpc(JOIN_NSID, 'AlreadyRequested', 409, 'You already have a pending join request');
    }
    if (status === 'rejected') {
      await query(
        `UPDATE join_requests SET status = 'pending', resolved_by = NULL, resolved_at = NULL, created_at = CURRENT_TIMESTAMP
         WHERE community_did = $1 AND user_id = $2`,
        [did, caller.userId],
      );
      return { status: 'pending' };
    }
  }

  await query(
    `INSERT INTO join_requests (id, community_did, user_id, user_did, status)
     VALUES ($1, $2, $3, $4, 'pending')`,
    [randomUUID(), did, caller.userId, caller.did],
  );

  return { status: 'pending' };
}

export async function leaveCommunityLifecycle(
  caller: AuthContext,
  input: LeaveCommunityInput,
): Promise<{ success: true }> {
  const communityDid = requireString(input.did, LEAVE_NSID, 'Missing required field: did');
  const community = await getCommunityOwner(communityDid, LEAVE_NSID);

  if (community.created_by === caller.userId) {
    throwXrpc(LEAVE_NSID, 'Forbidden', 403, 'The community owner cannot leave the community');
  }

  const memberRkey = await getMemberRkey(communityDid, caller.did);
  if (!memberRkey) {
    throwXrpc(LEAVE_NSID, 'NotMember', 400, 'You are not a member of this community');
  }

  await deleteMemberRecord(communityDid, memberRkey);
  await query(
    'DELETE FROM join_requests WHERE community_did = $1 AND user_id = $2',
    [communityDid, caller.userId],
  );

  return { success: true };
}

export async function removeMemberLifecycle(
  caller: AuthContext,
  input: RemoveMemberInput,
): Promise<{ success: true }> {
  const communityDid = requireString(input.did, REMOVE_NSID, 'Missing required fields: did, memberDid');
  const memberDid = requireString(input.memberDid, REMOVE_NSID, 'Missing required fields: did, memberDid');
  const community = await getCommunityOwner(communityDid, REMOVE_NSID);

  const isOwner = community.created_by === caller.userId;
  const isAdmin = caller.roles.includes('admin');
  if (!isOwner && !isAdmin) {
    throwXrpc(REMOVE_NSID, 'Forbidden', 403, 'Only the community owner or PDS admin can remove members');
  }

  const ownerDid = await getUserDid(community.created_by);
  if (ownerDid === memberDid) {
    throwXrpc(REMOVE_NSID, 'Forbidden', 403, 'Cannot remove the community owner');
  }

  const memberRkey = await getMemberRkey(communityDid, memberDid);
  if (!memberRkey) {
    throwXrpc(REMOVE_NSID, 'NotMember', 400, 'User is not a member of this community');
  }

  await deleteMemberRecord(communityDid, memberRkey);

  const removedUserId = await getUserIdByDid(memberDid);
  if (removedUserId) {
    await query(
      'DELETE FROM join_requests WHERE community_did = $1 AND user_id = $2',
      [communityDid, removedUserId],
    );
  }

  await auditLog('community.removeMember', caller.userId, communityDid, { memberDid });
  return { success: true };
}

export async function resolveJoinRequestLifecycle(
  caller: AuthContext,
  input: ResolveJoinRequestInput,
): Promise<{ status: 'approved' | 'rejected' }> {
  const requestId = requireString(
    input.requestId,
    RESOLVE_JOIN_REQUEST_NSID,
    'Missing required fields: requestId and action',
  );
  const action = requireString(
    input.action,
    RESOLVE_JOIN_REQUEST_NSID,
    'Missing required fields: requestId and action',
  );
  if (action !== 'approve' && action !== 'reject') {
    throwXrpc(RESOLVE_JOIN_REQUEST_NSID, 'InvalidRequest', 400, 'action must be "approve" or "reject"');
  }

  const requestResult = await query<{
    id: string;
    community_did: string;
    user_id: string;
    user_did: string;
    status: string;
  }>(
    'SELECT id, community_did, user_id, user_did, status FROM join_requests WHERE id = $1',
    [requestId],
  );
  if (requestResult.rows.length === 0) {
    throwXrpc(RESOLVE_JOIN_REQUEST_NSID, 'NotFound', 404, 'Join request not found');
  }

  const request = requestResult.rows[0];
  if (request.status !== 'pending') {
    throwXrpc(RESOLVE_JOIN_REQUEST_NSID, 'AlreadyResolved', 400, 'This join request has already been resolved');
  }

  const community = await getCommunityOwner(request.community_did, RESOLVE_JOIN_REQUEST_NSID);
  const isOwner = community.created_by === caller.userId;
  const isAdmin = caller.roles.includes('admin');
  if (!isOwner && !isAdmin) {
    throwXrpc(
      RESOLVE_JOIN_REQUEST_NSID,
      'Forbidden',
      403,
      'Only the community owner or admin can resolve join requests',
    );
  }

  const newStatus = action === 'approve' ? 'approved' : 'rejected';
  await query(
    `UPDATE join_requests SET status = $1, resolved_by = $2, resolved_at = CURRENT_TIMESTAMP WHERE id = $3`,
    [newStatus, caller.userId, requestId],
  );

  if (action === 'approve') {
    const handle = await getUserHandle(request.user_id);
    await createMemberRecordForDid(request.community_did, request.user_did, handle || 'unknown', {});
  }

  const auditAction = action === 'approve' ? 'join_request.approve' as const : 'join_request.reject' as const;
  await auditLog(auditAction, caller.userId, request.user_id, {
    communityDid: request.community_did,
  });

  return { status: newStatus };
}

export async function updateMemberLifecycle(
  caller: AuthContext,
  input: UpdateMemberInput,
): Promise<UpdateMemberResult> {
  const parsed = validateUpdateMemberInput(input);
  const {
    communityDid,
    memberDid,
    role,
    roleRkey,
    kind,
    tags,
    attributes,
    hasRole,
    hasRoleRkey,
    hasKind,
    hasTags,
    hasAttributes,
  } = parsed;

  const capabilities = await getCallerCommunityCapabilities({ communityDid, caller });
  if (!capabilities.exists) {
    throwXrpc(UPDATE_MEMBER_NSID, 'NotFound', 404, 'Community not found');
  }
  if (!capabilities.hasAllPermissions && !capabilities.permissions.includes('community.member.write')) {
    if (capabilities.membership?.status !== 'member') {
      throwXrpc(UPDATE_MEMBER_NSID, 'NotMember', 403, 'You must be a member of this community');
    }
    throwXrpc(UPDATE_MEMBER_NSID, 'Forbidden', 403, 'Insufficient community privileges');
  }

  let resolvedRoleName: string | undefined;
  if (hasRoleRkey && roleRkey) {
    const roleResult = await query<{ record: { name?: string } }>(
      `SELECT record FROM records_index WHERE community_did = $1 AND collection = $2 AND rkey = $3`,
      [communityDid, ROLE_COLLECTION, roleRkey],
    );
    if (roleResult.rows.length === 0) {
      throwXrpc(UPDATE_MEMBER_NSID, 'RoleNotFound', 404, 'Target role not found');
    }
    resolvedRoleName = roleResult.rows[0].record?.name;
  }

  const memberResult = await query<{ record_rkey: string }>(
    'SELECT record_rkey FROM members_unique WHERE community_did = $1 AND member_did = $2',
    [communityDid, memberDid],
  );
  if (memberResult.rows.length === 0) {
    throwXrpc(UPDATE_MEMBER_NSID, 'NotMember', 404, 'Target DID is not a member of this community');
  }

  const memberRkey = memberResult.rows[0].record_rkey;
  const engine = new RepoEngine(communityDid);
  const existing = await engine.getRecord(MEMBER_COLLECTION, memberRkey);
  if (!existing) {
    throwXrpc(UPDATE_MEMBER_NSID, 'NotMember', 404, 'Member record not found in repository');
  }

  const prev = existing.record as MemberRecord;
  if (prev.role === 'owner' && (hasRole || hasRoleRkey)) {
    throwXrpc(UPDATE_MEMBER_NSID, 'CannotChangeOwner', 403, "Cannot change the owner's role.");
  }

  const next: MemberRecord = { ...prev };
  if (hasRoleRkey) {
    if (roleRkey === null || roleRkey === '') {
      delete next.roleRkey;
    } else {
      next.roleRkey = roleRkey;
      delete next.role;
    }
  }
  if (hasRole) {
    if (role === null || role === '') {
      delete next.role;
    } else {
      next.role = role;
      if (!hasRoleRkey) delete next.roleRkey;
    }
  }
  if (hasKind) {
    if (kind === null || kind === '') delete next.kind;
    else next.kind = kind;
  }
  if (hasTags) {
    if (tags === null || (Array.isArray(tags) && tags.length === 0)) delete next.tags;
    else next.tags = tags;
  }
  if (hasAttributes) {
    if (attributes === null || (attributes && Object.keys(attributes).length === 0)) delete next.attributes;
    else next.attributes = attributes;
  }

  const keypair = await getKeypairForDid(communityDid);
  const result = await engine.putRecord(keypair, MEMBER_COLLECTION, memberRkey, next);

  await auditLog('community.updateMember', caller.userId, communityDid, {
    memberDid,
    changed: {
      role: hasRole,
      roleRkey: hasRoleRkey,
      kind: hasKind,
      tags: hasTags,
      attributes: hasAttributes,
    },
    resolvedRoleName,
  });

  return {
    uri: result.uri,
    cid: result.cid,
    role: next.role ?? resolvedRoleName,
    roleRkey: next.roleRkey,
    kind: next.kind,
    tags: next.tags,
    attributes: next.attributes,
  };
}

function validateJoinInput(input: JoinCommunityInput): {
  did: string;
  kind?: string;
  tags?: string[];
  attributes?: Record<string, unknown>;
} {
  if (typeof input.did !== 'string' || input.did.length === 0) {
    throwXrpc(JOIN_NSID, 'InvalidRequest', 400, 'Missing required field: did');
  }

  let kind: string | undefined;
  if (input.kind !== undefined && input.kind !== null) {
    if (typeof input.kind !== 'string' || input.kind.length === 0 || input.kind.length > MAX_KIND_LENGTH) {
      throwXrpc(JOIN_NSID, 'InvalidRequest', 400, `kind must be a non-empty string <= ${MAX_KIND_LENGTH} chars`);
    }
    kind = input.kind;
  }

  let tags: string[] | undefined;
  if (input.tags !== undefined && input.tags !== null) {
    if (!Array.isArray(input.tags) || input.tags.length > MAX_TAGS) {
      throwXrpc(JOIN_NSID, 'InvalidRequest', 400, `tags must be an array of up to ${MAX_TAGS} strings`);
    }
    for (const tag of input.tags) {
      if (typeof tag !== 'string' || tag.length === 0 || tag.length > MAX_TAG_LENGTH) {
        throwXrpc(JOIN_NSID, 'InvalidRequest', 400, `each tag must be a non-empty string <= ${MAX_TAG_LENGTH} chars`);
      }
    }
    tags = input.tags;
  }

  let attributes: Record<string, unknown> | undefined;
  if (input.attributes !== undefined && input.attributes !== null) {
    if (typeof input.attributes !== 'object' || Array.isArray(input.attributes)) {
      throwXrpc(JOIN_NSID, 'InvalidRequest', 400, 'attributes must be a JSON object');
    }
    if (JSON.stringify(input.attributes).length > MAX_ATTRIBUTES_SIZE) {
      throwXrpc(JOIN_NSID, 'PayloadTooLarge', 400, `attributes must not exceed ${MAX_ATTRIBUTES_SIZE} bytes when serialized as JSON`);
    }
    attributes = input.attributes as Record<string, unknown>;
  }

  return { did: input.did, kind, tags, attributes };
}

function validateUpdateMemberInput(input: UpdateMemberInput): {
  communityDid: string;
  memberDid: string;
  role?: string | null;
  roleRkey?: string | null;
  kind?: string | null;
  tags?: string[] | null;
  attributes?: Record<string, unknown> | null;
  hasRole: boolean;
  hasRoleRkey: boolean;
  hasKind: boolean;
  hasTags: boolean;
  hasAttributes: boolean;
} {
  const communityDid = requireString(
    input.communityDid,
    UPDATE_MEMBER_NSID,
    'Missing required fields: communityDid, memberDid',
  );
  const memberDid = requireString(
    input.memberDid,
    UPDATE_MEMBER_NSID,
    'Missing required fields: communityDid, memberDid',
  );

  const hasRole = input.role !== undefined;
  const hasRoleRkey = input.roleRkey !== undefined;
  const hasKind = input.kind !== undefined;
  const hasTags = input.tags !== undefined;
  const hasAttributes = input.attributes !== undefined;

  if (!hasRole && !hasRoleRkey && !hasKind && !hasTags && !hasAttributes) {
    throwXrpc(
      UPDATE_MEMBER_NSID,
      'InvalidRequest',
      400,
      'Supply at least one of: role, roleRkey, kind, tags, attributes',
    );
  }

  let role: string | null | undefined;
  if (hasRole) {
    if (input.role !== null && input.role !== '') {
      if (typeof input.role !== 'string') {
        throwXrpc(UPDATE_MEMBER_NSID, 'InvalidRequest', 400, 'role must be a string or null');
      }
      if (input.role === 'owner') {
        throwXrpc(
          UPDATE_MEMBER_NSID,
          'InvalidRequest',
          400,
          "Cannot assign role 'owner' via updateMember; use community.transfer.",
        );
      }
    }
    role = input.role as string | null;
  }

  let roleRkey: string | null | undefined;
  if (hasRoleRkey) {
    if (input.roleRkey !== null && input.roleRkey !== '' && typeof input.roleRkey !== 'string') {
      throwXrpc(UPDATE_MEMBER_NSID, 'InvalidRequest', 400, 'roleRkey must be a string or null');
    }
    roleRkey = input.roleRkey as string | null;
  }

  let kind: string | null | undefined;
  if (hasKind) {
    if (input.kind !== null && input.kind !== '') {
      if (typeof input.kind !== 'string' || input.kind.length > MAX_KIND_LENGTH) {
        throwXrpc(UPDATE_MEMBER_NSID, 'InvalidRequest', 400, `kind must be a string <= ${MAX_KIND_LENGTH} chars`);
      }
    }
    kind = input.kind as string | null;
  }

  let tags: string[] | null | undefined;
  if (hasTags) {
    if (input.tags !== null) {
      if (!Array.isArray(input.tags) || input.tags.length > MAX_TAGS) {
        throwXrpc(UPDATE_MEMBER_NSID, 'InvalidRequest', 400, `tags must be an array of up to ${MAX_TAGS} strings`);
      }
      for (const tag of input.tags) {
        if (typeof tag !== 'string' || tag.length === 0 || tag.length > MAX_TAG_LENGTH) {
          throwXrpc(
            UPDATE_MEMBER_NSID,
            'InvalidRequest',
            400,
            `each tag must be a non-empty string <= ${MAX_TAG_LENGTH} chars`,
          );
        }
      }
    }
    tags = input.tags as string[] | null;
  }

  let attributes: Record<string, unknown> | null | undefined;
  if (hasAttributes) {
    if (input.attributes !== null) {
      if (typeof input.attributes !== 'object' || Array.isArray(input.attributes)) {
        throwXrpc(UPDATE_MEMBER_NSID, 'InvalidRequest', 400, 'attributes must be a JSON object');
      }
      if (JSON.stringify(input.attributes).length > MAX_ATTRIBUTES_SIZE) {
        throwXrpc(
          UPDATE_MEMBER_NSID,
          'PayloadTooLarge',
          400,
          `attributes must not exceed ${MAX_ATTRIBUTES_SIZE} bytes when serialized as JSON`,
        );
      }
    }
    attributes = input.attributes as Record<string, unknown> | null;
  }

  return {
    communityDid,
    memberDid,
    role,
    roleRkey,
    kind,
    tags,
    attributes,
    hasRole,
    hasRoleRkey,
    hasKind,
    hasTags,
    hasAttributes,
  };
}

function requireString(value: unknown, nsid: string, message: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throwXrpc(nsid, 'InvalidRequest', 400, message);
  }
  return value;
}

async function ensureCommunityExists(communityDid: string): Promise<void> {
  const communityResult = await query<{ did: string }>(
    'SELECT did FROM communities WHERE did = $1',
    [communityDid],
  );
  if (communityResult.rows.length === 0) {
    throwXrpc(JOIN_NSID, 'NotFound', 404, 'Community not found');
  }
}

async function getCommunityOwner(communityDid: string, nsid: string): Promise<{ created_by: string }> {
  const communityResult = await query<{ created_by: string }>(
    'SELECT created_by FROM communities WHERE did = $1',
    [communityDid],
  );
  if (communityResult.rows.length === 0) {
    throwXrpc(nsid, 'NotFound', 404, 'Community not found');
  }
  return communityResult.rows[0];
}

async function ensureNotAlreadyMember(communityDid: string, memberDid: string): Promise<void> {
  const memberCheck = await query(
    'SELECT 1 FROM members_unique WHERE community_did = $1 AND member_did = $2',
    [communityDid, memberDid],
  );
  if (memberCheck.rows.length > 0) {
    throwXrpc(JOIN_NSID, 'AlreadyMember', 409, 'You are already a member of this community');
  }
}

async function getMemberRkey(communityDid: string, memberDid: string): Promise<string | null> {
  const memberResult = await query<{ record_rkey: string }>(
    'SELECT record_rkey FROM members_unique WHERE community_did = $1 AND member_did = $2',
    [communityDid, memberDid],
  );
  return memberResult.rows[0]?.record_rkey || null;
}

async function deleteMemberRecord(communityDid: string, rkey: string): Promise<void> {
  const engine = new RepoEngine(communityDid);
  const keypair = await getKeypairForDid(communityDid);
  await engine.deleteRecord(keypair, MEMBER_COLLECTION, rkey);
}

async function getUserDid(userId: string): Promise<string | null> {
  const result = await query<{ did: string }>(
    'SELECT did FROM users WHERE id = $1',
    [userId],
  );
  return result.rows[0]?.did || null;
}

async function getUserIdByDid(did: string): Promise<string | null> {
  const result = await query<{ id: string }>(
    'SELECT id FROM users WHERE did = $1',
    [did],
  );
  return result.rows[0]?.id || null;
}

async function getUserHandle(userId: string): Promise<string | null> {
  const result = await query<{ handle: string }>(
    'SELECT handle FROM users WHERE id = $1',
    [userId],
  );
  return result.rows[0]?.handle || null;
}

async function getJoinPolicy(communityDid: string): Promise<string> {
  const settingsResult = await query<{ record: { joinPolicy?: string } }>(
    `SELECT record FROM records_index
     WHERE community_did = $1 AND collection = 'net.openfederation.community.settings' AND rkey = 'self'`,
    [communityDid],
  );
  return settingsResult.rows[0]?.record?.joinPolicy || 'open';
}

async function createMemberRecord(
  communityDid: string,
  caller: AuthContext,
  semantic: { kind?: string; tags?: string[]; attributes?: Record<string, unknown> },
): Promise<void> {
  return createMemberRecordForDid(communityDid, caller.did, caller.handle, semantic);
}

async function createMemberRecordForDid(
  communityDid: string,
  memberDid: string,
  handle: string,
  semantic: { kind?: string; tags?: string[]; attributes?: Record<string, unknown> },
): Promise<void> {
  const engine = new RepoEngine(communityDid);
  const keypair = await getKeypairForDid(communityDid);
  const rkey = RepoEngine.generateTid();
  const memberRoleRkey = await findRoleRkeyByName(communityDid, 'member', query);
  const memberRecord: Record<string, unknown> = {
    did: memberDid,
    handle,
    ...(memberRoleRkey ? { roleRkey: memberRoleRkey } : { role: 'member' }),
    joinedAt: new Date().toISOString(),
  };
  if (semantic.kind) memberRecord.kind = semantic.kind;
  if (semantic.tags && semantic.tags.length > 0) memberRecord.tags = semantic.tags;
  if (semantic.attributes && Object.keys(semantic.attributes).length > 0) {
    memberRecord.attributes = semantic.attributes;
  }

  await engine.putRecord(keypair, MEMBER_COLLECTION, rkey, memberRecord);
}
