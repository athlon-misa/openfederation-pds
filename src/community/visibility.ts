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

const LEGACY_ROLE_PERMISSIONS: Record<string, string[]> = {
  owner: [...ALL_PERMISSIONS],
  moderator: [
    'community.profile.write',
    'community.member.read',
    'community.member.write',
    'community.member.delete',
    'community.role.read',
    'community.attestation.write',
    'community.attestation.delete',
    'community.governance.write',
  ],
  member: ['community.member.read', 'community.role.read'],
};

export async function getCallerMembership(opts: {
  communityDid: string;
  caller?: AuthContext;
}): Promise<CallerMembership | null> {
  const { communityDid, caller } = opts;
  if (!caller) return null;

  const memberResult = await query<{ record_rkey: string }>(
    'SELECT record_rkey FROM members_unique WHERE community_did = $1 AND member_did = $2',
    [communityDid, caller.did],
  );

  if (memberResult.rows.length > 0) {
    const memberRecord = await query<{ record: MemberRecord }>(
      `SELECT record FROM records_index
       WHERE community_did = $1 AND collection = $2 AND rkey = $3`,
      [communityDid, MEMBER_COLLECTION, memberResult.rows[0].record_rkey],
    );

    const member = memberRecord.rows[0]?.record ?? {};
    const membership: CallerMembership = {
      status: 'member',
      role: member.role ?? (member.roleRkey ? 'custom' : 'member'),
    };

    if (member.roleRkey) {
      membership.roleRkey = member.roleRkey;
      const roleResult = await query<{ record: { name?: string } }>(
        `SELECT record FROM records_index
         WHERE community_did = $1 AND collection = $2 AND rkey = $3`,
        [communityDid, ROLE_COLLECTION, member.roleRkey],
      );
      const roleName = roleResult.rows[0]?.record?.name;
      if (roleName) membership.role = roleName;
    }
    if (member.kind) membership.kind = member.kind;
    if (Array.isArray(member.tags) && member.tags.length > 0) membership.tags = member.tags;
    if (member.attributes && Object.keys(member.attributes).length > 0) {
      membership.attributes = member.attributes;
    }

    return membership;
  }

  const joinRequest = await query<{ status: CallerMembershipStatus }>(
    `SELECT status FROM join_requests
     WHERE community_did = $1 AND user_id = $2`,
    [communityDid, caller.userId],
  );

  const status = joinRequest.rows[0]?.status;
  if (!status) return null;

  return {
    status,
    joinRequestStatus: status,
  };
}

export async function getCommunityAccess(opts: {
  communityDid: string;
  caller?: AuthContext;
}): Promise<CommunityAccess> {
  const { communityDid, caller } = opts;
  const [communityResult, settingsResult, membership] = await Promise.all([
    query<{ created_by: string }>(
      'SELECT created_by FROM communities WHERE did = $1',
      [communityDid],
    ),
    query<{ record: { visibility?: string } }>(
      `SELECT record FROM records_index
       WHERE community_did = $1 AND collection = 'net.openfederation.community.settings' AND rkey = 'self'`,
      [communityDid],
    ),
    getCallerMembership({ communityDid, caller }),
  ]);

  const community = communityResult.rows[0];
  if (!community) {
    return {
      exists: false,
      isAdmin: false,
      isOwner: false,
      membership,
    };
  }

  return {
    exists: true,
    createdBy: community.created_by,
    visibility: settingsResult.rows[0]?.record?.visibility || 'public',
    isAdmin: caller?.roles.includes('admin') || false,
    isOwner: caller ? community.created_by === caller.userId : false,
    membership,
  };
}

export async function getCallerCommunityCapabilities(opts: {
  communityDid: string;
  caller: AuthContext;
}): Promise<CallerCommunityCapabilities> {
  const access = await getCommunityAccess(opts);
  if (!access.exists) {
    return {
      ...access,
      hasAllPermissions: false,
      permissions: [],
    };
  }

  if (access.isAdmin || access.isOwner) {
    return {
      ...access,
      hasAllPermissions: true,
      permissions: [...ALL_PERMISSIONS],
    };
  }

  const membership = access.membership;
  if (!membership || membership.status !== 'member') {
    return {
      ...access,
      hasAllPermissions: false,
      permissions: [],
    };
  }

  if (membership.roleRkey) {
    const roleResult = await query<{ record: { permissions?: string[] } }>(
      `SELECT record FROM records_index
       WHERE community_did = $1 AND collection = $2 AND rkey = $3`,
      [opts.communityDid, ROLE_COLLECTION, membership.roleRkey],
    );
    return {
      ...access,
      hasAllPermissions: false,
      permissions: roleResult.rows[0]?.record?.permissions || [],
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
