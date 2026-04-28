import type { AuthContext } from '../../auth/types.js';
import { query } from '../../db/client.js';
import { MEMBER_COLLECTION, ROLE_COLLECTION } from '../../auth/permissions.js';
import { RepoEngine } from '../../repo/repo-engine.js';
import { getKeypairForDid } from '../../repo/keypair-utils.js';
import { throwXrpc } from '../../xrpc/errors.js';
import { auditLog } from '../../db/audit.js';
import { getCallerCommunityCapabilities } from '../visibility.js';
import { requireString } from './utils.js';
import { syncMemberRoleProjection } from '../display-projection.js';

const UPDATE_MEMBER_NSID = 'net.openfederation.community.updateMember';
const MAX_KIND_LENGTH = 64;
const MAX_TAGS = 20;
const MAX_TAG_LENGTH = 64;
const MAX_ATTRIBUTES_SIZE = 4096;

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

  // Sync projection columns that changed
  await syncMemberRoleProjection(communityDid, memberDid, {
    role: next.role ?? null,
    roleRkey: next.roleRkey ?? null,
    kind: next.kind ?? null,
    tags: next.tags ?? null,
    attributes: next.attributes ?? null,
  });

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
