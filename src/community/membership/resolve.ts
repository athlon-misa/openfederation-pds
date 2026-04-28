import type { AuthContext } from '../../auth/types.js';
import { query } from '../../db/client.js';
import { throwXrpc } from '../../xrpc/errors.js';
import { auditLog } from '../../db/audit.js';
import { requireString, getCommunityOwner, createMemberRecordForDid, getUserHandle } from './utils.js';

const RESOLVE_JOIN_REQUEST_NSID = 'net.openfederation.community.resolveJoinRequest';

export interface ResolveJoinRequestInput {
  requestId?: unknown;
  action?: unknown;
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
