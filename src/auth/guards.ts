import type { Response } from 'express';
import type { AuthRequest, AuthContext, UserRole, CommunityRole, CommunityStatus } from './types.js';
import { query } from '../db/client.js';
import { getCallerCommunityCapabilities } from '../community/visibility.js';

export function requireAuth(req: AuthRequest, res: Response): req is AuthRequest & { auth: AuthContext } {
  if (!req.auth) {
    if (req.serviceAuthError) {
      res.status(req.serviceAuthError.status).json({
        error: req.serviceAuthError.code,
        message: req.serviceAuthError.message,
      });
      return false;
    }
    res.status(401).json({
      error: 'Unauthorized',
      message: req.authError === 'invalid' ? 'Invalid access token' : 'Missing access token',
    });
    return false;
  }
  return true;
}

export function requireRole(req: AuthRequest, res: Response, roles: UserRole[]): boolean {
  if (!requireAuth(req, res)) {
    return false;
  }

  const hasRole = roles.some((role) => req.auth.roles.includes(role));
  if (!hasRole) {
    res.status(403).json({
      error: 'Forbidden',
      message: 'Insufficient privileges',
    });
    return false;
  }

  return true;
}

export function requireApprovedUser(req: AuthRequest, res: Response): boolean {
  if (!requireAuth(req, res)) {
    return false;
  }

  if (req.auth.status === 'suspended') {
    res.status(403).json({
      error: 'AccountSuspended',
      message: 'Your account has been suspended.',
    });
    return false;
  }

  if (req.auth.status === 'takendown') {
    res.status(410).json({
      error: 'AccountTakenDown',
      message: 'Your account has been taken down.',
    });
    return false;
  }

  if (req.auth.status === 'deactivated') {
    res.status(403).json({
      error: 'AccountDeactivated',
      message: 'Your account is deactivated. Reactivate it to continue.',
    });
    return false;
  }

  if (req.auth.status !== 'approved') {
    res.status(403).json({
      error: 'AccountNotApproved',
      message: 'Your account must be approved before performing this action.',
    });
    return false;
  }

  return true;
}

/**
 * Check if a community is in an active state (not suspended or taken down).
 * Returns community info if active, sends error response otherwise.
 */
export async function requireActiveCommunity(
  communityDid: string,
  res: Response
): Promise<{ did: string; handle: string; created_by: string; status: CommunityStatus } | null> {
  const result = await query<{
    did: string;
    handle: string;
    created_by: string;
    status: CommunityStatus;
  }>(
    'SELECT did, handle, created_by, status FROM communities WHERE did = $1',
    [communityDid]
  );

  if (result.rows.length === 0) {
    res.status(404).json({ error: 'NotFound', message: 'Community not found' });
    return null;
  }

  const community = result.rows[0];

  if (community.status === 'suspended') {
    res.status(403).json({
      error: 'CommunitySuspended',
      message: 'This community has been suspended by the PDS administrator.',
    });
    return null;
  }

  if (community.status === 'takendown') {
    res.status(410).json({
      error: 'CommunityTakenDown',
      message: 'This community has been taken down.',
    });
    return null;
  }

  return community;
}

/**
 * Verify the caller has the required community role.
 * Checks: PDS admin always passes, then owner, moderator, member in descending order.
 * Returns the caller's community role if authorized, null otherwise.
 */
export async function requireCommunityRole(
  req: AuthRequest & { auth: AuthContext },
  res: Response,
  communityDid: string,
  requiredRoles: CommunityRole[]
): Promise<CommunityRole | null> {
  // PDS admin always has access
  if (req.auth.roles.includes('admin')) {
    return 'owner'; // treat admin as equivalent to owner for access purposes
  }

  // Check if user is owner
  const communityResult = await query<{ created_by: string }>(
    'SELECT created_by FROM communities WHERE did = $1',
    [communityDid]
  );

  if (communityResult.rows.length === 0) {
    res.status(404).json({ error: 'NotFound', message: 'Community not found' });
    return null;
  }

  const isOwner = communityResult.rows[0].created_by === req.auth.userId;
  if (isOwner && requiredRoles.includes('owner')) {
    return 'owner';
  }

  // Check member record for role
  const memberResult = await query<{ record_rkey: string }>(
    'SELECT record_rkey FROM members_unique WHERE community_did = $1 AND member_did = $2',
    [communityDid, req.auth.did]
  );

  if (memberResult.rows.length === 0) {
    if (requiredRoles.includes('member')) {
      res.status(403).json({ error: 'NotMember', message: 'You must be a member of this community' });
    } else {
      res.status(403).json({ error: 'Forbidden', message: 'Insufficient community privileges' });
    }
    return null;
  }

  // If owner is required and they're not owner, check if they have a matching role
  if (isOwner) return 'owner';

  // Get the role from the member record
  const recordResult = await query<{ record: { role?: string } }>(
    `SELECT record FROM records_index
     WHERE community_did = $1 AND collection = 'net.openfederation.community.member' AND rkey = $2`,
    [communityDid, memberResult.rows[0].record_rkey]
  );

  const memberRole = (recordResult.rows[0]?.record?.role || 'member') as CommunityRole;

  // Role hierarchy: owner > moderator > member
  const roleHierarchy: Record<CommunityRole, number> = { owner: 3, moderator: 2, member: 1 };
  const callerLevel = roleHierarchy[memberRole] || 0;
  const requiredLevel = Math.min(...requiredRoles.map(r => roleHierarchy[r] || 0));

  if (callerLevel >= requiredLevel) {
    return memberRole;
  }

  res.status(403).json({ error: 'Forbidden', message: 'Insufficient community privileges' });
  return null;
}

/**
 * Permission-based community authorization.
 * Resolves member's roleRkey → role record → permissions array.
 * PDS admin and community creator always pass.
 */
export async function requireCommunityPermission(
  req: AuthRequest & { auth: AuthContext },
  res: Response,
  communityDid: string,
  permission: string
): Promise<boolean> {
  const capabilities = await getCallerCommunityCapabilities({
    communityDid,
    caller: req.auth,
  });

  if (!capabilities.exists) {
    res.status(404).json({ error: 'NotFound', message: 'Community not found' });
    return false;
  }

  if (capabilities.hasAllPermissions || capabilities.permissions.includes(permission)) {
    return true;
  }

  if (capabilities.membership?.status !== 'member') {
    res.status(403).json({ error: 'NotMember', message: 'You must be a member of this community' });
    return false;
  }

  res.status(403).json({ error: 'Forbidden', message: 'Insufficient community privileges' });
  return false;
}
