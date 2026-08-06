import type { AuthContext } from '../auth/types.js';
import { query } from '../db/client.js';
import { ALL_PERMISSIONS, MEMBER_COLLECTION, ROLE_COLLECTION } from '../auth/permissions.js';

export type CallerMembershipStatus = 'member' | 'pending' | 'approved' | 'rejected';

export interface CallerMembership {
  status: CallerMembershipStatus;
  role?: string;
  roleRkey?: string;
  kind?: string;
  tags?: string[];
  attributes?: Record<string, unknown>;
  joinRequestStatus?: string;
}

type MemberRecord = {
  role?: string;
  roleRkey?: string;
  kind?: string;
  tags?: string[];
  attributes?: Record<string, unknown>;
};

export interface CommunityAccess {
  exists: boolean;
  createdBy?: string;
  visibility?: string;
  isAdmin: boolean;
  isOwner: boolean;
  membership: CallerMembership | null;
}

export interface CallerCommunityCapabilities extends CommunityAccess {
  hasAllPermissions: boolean;
  permissions: string[];
}

// Shared with the offline verifier; see decision-rules.ts.
export { LEGACY_ROLE_PERMISSIONS } from '../governance/decision-rules.js';
import { LEGACY_ROLE_PERMISSIONS } from '../governance/decision-rules.js';

type RoleRecord = { name?: string; permissions?: string[] };

type CommunityContextRow = {
  created_by: string | null;
  visibility: string | null;
  member_rkey: string | null;
  member_record: MemberRecord | null;
  role_record: RoleRecord | null;
  join_request_status: CallerMembershipStatus | null;
};

/**
 * One round-trip for everything the access/permission checks need:
 * community row, settings visibility, caller's member record, the member's
 * role record, and any join request. Uniqueness guarantees (members_unique
 * and join_requests both have UNIQUE constraints per caller+community;
 * records_index is unique per (community, collection, rkey)) mean this
 * returns at most one row.
 */
async function loadCommunityContext(
  communityDid: string,
  caller?: AuthContext,
): Promise<CommunityContextRow | null> {
  const result = await query<CommunityContextRow>(
    `SELECT
       c.created_by,
       s.record->>'visibility' AS visibility,
       mu.record_rkey          AS member_rkey,
       mr.record               AS member_record,
       rr.record               AS role_record,
       jr.status               AS join_request_status
     FROM communities c
     LEFT JOIN records_index s
       ON s.community_did = c.did
      AND s.collection = 'net.openfederation.community.settings'
      AND s.rkey = 'self'
     LEFT JOIN members_unique mu
       ON mu.community_did = c.did AND mu.member_did = $2
     LEFT JOIN records_index mr
       ON mr.community_did = c.did AND mr.collection = $3 AND mr.rkey = mu.record_rkey
     LEFT JOIN records_index rr
       ON rr.community_did = c.did AND rr.collection = $4 AND rr.rkey = mr.record->>'roleRkey'
     LEFT JOIN join_requests jr
       ON jr.community_did = c.did AND jr.user_id = $5
     WHERE c.did = $1`,
    [communityDid, caller?.did ?? null, MEMBER_COLLECTION, ROLE_COLLECTION, caller?.userId ?? null],
  );
  return result.rows[0] ?? null;
}

function membershipFromRow(row: CommunityContextRow | null): CallerMembership | null {
  if (!row) return null;

  if (row.member_rkey) {
    const member = row.member_record ?? {};
    const membership: CallerMembership = {
      status: 'member',
      role: member.role ?? (member.roleRkey ? 'custom' : 'member'),
    };
    if (member.roleRkey) {
      membership.roleRkey = member.roleRkey;
      const roleName = row.role_record?.name;
      if (roleName) membership.role = roleName;
    }
    if (member.kind) membership.kind = member.kind;
    if (Array.isArray(member.tags) && member.tags.length > 0) membership.tags = member.tags;
    if (member.attributes && Object.keys(member.attributes).length > 0) {
      membership.attributes = member.attributes;
    }
    return membership;
  }

  if (!row.join_request_status) return null;
  return { status: row.join_request_status, joinRequestStatus: row.join_request_status };
}

export async function getCallerMembership(opts: {
  communityDid: string;
  caller?: AuthContext;
}): Promise<CallerMembership | null> {
  if (!opts.caller) return null;
  const row = await loadCommunityContext(opts.communityDid, opts.caller);
  return membershipFromRow(row);
}

export async function getCommunityAccess(opts: {
  communityDid: string;
  caller?: AuthContext;
}): Promise<CommunityAccess> {
  const { communityDid, caller } = opts;
  const row = await loadCommunityContext(communityDid, caller);
  const membership = caller ? membershipFromRow(row) : null;

  if (!row) {
    return { exists: false, isAdmin: false, isOwner: false, membership };
  }

  return {
    exists: true,
    createdBy: row.created_by ?? undefined,
    visibility: row.visibility || 'public',
    isAdmin: caller?.roles.includes('admin') || false,
    isOwner: caller ? row.created_by === caller.userId : false,
    membership,
  };
}

export async function getCallerCommunityCapabilities(opts: {
  communityDid: string;
  caller: AuthContext;
}): Promise<CallerCommunityCapabilities> {
  const row = await loadCommunityContext(opts.communityDid, opts.caller);
  const membership = membershipFromRow(row);

  if (!row) {
    return {
      exists: false,
      isAdmin: false,
      isOwner: false,
      membership,
      hasAllPermissions: false,
      permissions: [],
    };
  }

  const access: CommunityAccess = {
    exists: true,
    createdBy: row.created_by ?? undefined,
    visibility: row.visibility || 'public',
    isAdmin: opts.caller.roles.includes('admin'),
    isOwner: row.created_by === opts.caller.userId,
    membership,
  };

  if (access.isAdmin || access.isOwner) {
    return { ...access, hasAllPermissions: true, permissions: [...ALL_PERMISSIONS] };
  }

  if (!membership || membership.status !== 'member') {
    return { ...access, hasAllPermissions: false, permissions: [] };
  }

  if (membership.roleRkey) {
    return {
      ...access,
      hasAllPermissions: false,
      permissions: row.role_record?.permissions || [],
    };
  }

  return {
    ...access,
    hasAllPermissions: false,
    permissions: LEGACY_ROLE_PERMISSIONS[membership.role || 'member'] || [],
  };
}

export function canViewPrivateCommunity(access: CommunityAccess): boolean {
  return access.isAdmin || access.isOwner || access.membership?.status === 'member';
}

/**
 * True if the authenticated caller (if any) holds community.forum.moderate in
 * this community — the single gate for seeing/hiding forum moderation
 * content. Used identically by forum.getThread and forum.listThreads so the
 * permission check can never drift between call sites.
 */
export async function callerCanModerateForum(
  communityDid: string,
  caller: AuthContext | undefined,
): Promise<boolean> {
  if (!caller) return false;
  const caps = await getCallerCommunityCapabilities({ communityDid, caller });
  return caps.hasAllPermissions || caps.permissions.includes('community.forum.moderate');
}
