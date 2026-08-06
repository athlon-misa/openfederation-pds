import type { Response } from 'express';
import type { AuthRequest, AuthContext, UserRole, CommunityRole, CommunityStatus } from './types.js';
import type { PartnerContext } from './partner-guard.js';
import { query } from '../db/client.js';
import { getCallerCommunityCapabilities, getCommunityAccess, canViewPrivateCommunity } from '../community/visibility.js';
import { HttpError } from '../xrpc/errors.js';

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

/**
 * Guard: the community must exist and be readable by the caller.
 *
 * Public communities are readable by anyone (including unauthenticated
 * callers). Private communities are readable only by their owner, a PDS
 * admin, or a member. On failure this returns 404 (never 403) so the
 * existence of a private community is not leaked to outsiders — matching
 * net.openfederation.community.get.
 *
 * Use on read endpoints that expose a community's data (forum, calendar,
 * etc.) so they enforce the same visibility gate as community.get /
 * listMembers and can't drift apart.
 */
export async function requireCommunityReadable(
  req: AuthRequest,
  res: Response,
  communityDid: string,
): Promise<boolean> {
  const access = await getCommunityAccess({ communityDid, caller: req.auth });
  if (!access.exists || (access.visibility === 'private' && !canViewPrivateCommunity(access))) {
    res.status(404).json({ error: 'NotFound', message: 'Community not found' });
    return false;
  }
  return true;
}

/**
 * Guard: a raw repo DID must be readable by the caller.
 *
 * For the generic ATProto repo endpoints (repo.listRecords / getRecord /
 * describeRepo, sync.getRepo) the `repo`/`did` param may be either a user DID
 * or a community DID. User repos stay public per ATProto ("only extend, never
 * replace"). Community repos are extended with privacy: a *private* community's
 * repo is readable only by its owner, a PDS admin, or a member.
 *
 * DIDs that don't resolve to a community (user DIDs, unknown DIDs) pass through
 * untouched — the caller keeps ATProto's public-repo behaviour and the handler
 * decides existence. Only a private, non-viewable community is blocked, with a
 * 404 so its existence isn't leaked.
 */
export async function requireRepoReadable(
  req: AuthRequest,
  res: Response,
  did: string,
): Promise<boolean> {
  const access = await getCommunityAccess({ communityDid: did, caller: req.auth });
  if (access.exists && access.visibility === 'private' && !canViewPrivateCommunity(access)) {
    res.status(404).json({ error: 'RepoNotFound', message: `Repository not found for DID: ${did}` });
    return false;
  }
  return true;
}

/**
 * Guard: require a valid partner key (set by authMiddleware from X-Partner-Key header).
 * Sends 401 when no partner is authenticated; 403 when the required permission is absent.
 */
export function requirePartnerAuth(
  req: AuthRequest,
  res: Response,
  requiredPermission: string
): req is AuthRequest & { partnerAuth: PartnerContext } {
  if (!req.partnerAuth) {
    if (req.partnerAuthError) {
      res.status(req.partnerAuthError.status).json({
        error: req.partnerAuthError.code,
        message: req.partnerAuthError.message,
      });
    } else {
      res.status(401).json({ error: 'AuthRequired', message: 'Valid X-Partner-Key header required' });
    }
    return false;
  }
  if (!req.partnerAuth.permissions.includes(requiredPermission)) {
    res.status(403).json({ error: 'Forbidden', message: `Partner key lacks '${requiredPermission}' permission` });
    return false;
  }
  return true;
}

// ── Throwing guard variants ──────────────────────────────────────
// These mirror the require* guards above but throw HttpError instead of
// writing to `res`. The central XRPC dispatcher (and renderXrpcError in
// handlers that keep a local try/catch) turns the throw into the identical
// HTTP response. Prefer these in new/migrated handlers.

export function assertAuth(req: AuthRequest): asserts req is AuthRequest & { auth: AuthContext } {
  if (!req.auth) {
    if (req.serviceAuthError) {
      throw new HttpError(req.serviceAuthError.status, req.serviceAuthError.code, req.serviceAuthError.message);
    }
    throw new HttpError(
      401,
      'Unauthorized',
      req.authError === 'invalid' ? 'Invalid access token' : 'Missing access token',
    );
  }
}

export function assertRole(req: AuthRequest, roles: UserRole[]): asserts req is AuthRequest & { auth: AuthContext } {
  assertAuth(req);
  const hasRole = roles.some((role) => req.auth.roles.includes(role));
  if (!hasRole) {
    throw new HttpError(403, 'Forbidden', 'Insufficient privileges');
  }
}

export function assertApprovedUser(req: AuthRequest): asserts req is AuthRequest & { auth: AuthContext } {
  assertAuth(req);
  if (req.auth.status === 'suspended') {
    throw new HttpError(403, 'AccountSuspended', 'Your account has been suspended.');
  }
  if (req.auth.status === 'takendown') {
    throw new HttpError(410, 'AccountTakenDown', 'Your account has been taken down.');
  }
  if (req.auth.status === 'deactivated') {
    throw new HttpError(403, 'AccountDeactivated', 'Your account is deactivated. Reactivate it to continue.');
  }
  if (req.auth.status !== 'approved') {
    throw new HttpError(403, 'AccountNotApproved', 'Your account must be approved before performing this action.');
  }
}

/** Async — TypeScript does not allow async assertion signatures, so callers must assertAuth first. */
export async function assertCommunityPermission(
  req: AuthRequest & { auth: AuthContext },
  communityDid: string,
  permission: string,
): Promise<void> {
  const capabilities = await getCallerCommunityCapabilities({ communityDid, caller: req.auth });
  if (!capabilities.exists) {
    throw new HttpError(404, 'NotFound', 'Community not found');
  }
  if (capabilities.hasAllPermissions || capabilities.permissions.includes(permission)) {
    return;
  }
  if (capabilities.membership?.status !== 'member') {
    throw new HttpError(403, 'NotMember', 'You must be a member of this community');
  }
  throw new HttpError(403, 'Forbidden', 'Insufficient community privileges');
}
