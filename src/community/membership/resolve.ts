import type { AuthContext } from '../../auth/types.js';
import { query } from '../../db/client.js';
import { throwXrpc } from '../../xrpc/errors.js';
import { auditLog } from '../../db/audit.js';
import {
  requireString, getCommunityOwner, ensureCommunityWritable, createMemberRecordForDid, getUserHandle, getMemberRkey,
} from './utils.js';

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

  await ensureCommunityWritable(request.community_did, RESOLVE_JOIN_REQUEST_NSID);
  const community = await getCommunityOwner(request.community_did, RESOLVE_JOIN_REQUEST_NSID);
  const isOwner = community.ownerDid === caller.did;
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
  // resolved_by references a local account. An owner acting from another PDS
  // has none, so the column is left empty for them (the audit entry names them).
  const resolverId = caller.authMethod === 'service-auth' && caller.userId === caller.did ? null : caller.userId;
  // Claim the request in one statement. The check above read 'pending' a
  // moment ago; of several resolutions arriving together, only the one whose
  // update still finds it pending goes on.
  const claimed = await query(
    `UPDATE join_requests SET status = $1, resolved_by = $2, resolved_at = CURRENT_TIMESTAMP
     WHERE id = $3 AND status = 'pending'`,
    [newStatus, resolverId, requestId],
  );
  if (claimed.rowCount !== 1) {
    throwXrpc(RESOLVE_JOIN_REQUEST_NSID, 'AlreadyResolved', 400, 'This join request has already been resolved');
  }

  if (action === 'approve') {
    try {
      // Someone who became a member another way in the meantime needs no second record.
      if (!(await getMemberRkey(request.community_did, request.user_did))) {
        const handle = await getUserHandle(request.user_id);
        await createMemberRecordForDid(request.community_did, request.user_did, handle || 'unknown', {});
      }
    } catch (err) {
      // The membership was not created, so the request is not approved. Put
      // it back to pending: left as 'approved' it could be neither resolved
      // again nor re-submitted, and the person would be locked out for good.
      await query(
        `UPDATE join_requests SET status = 'pending', resolved_by = NULL, resolved_at = NULL WHERE id = $1`,
        [requestId],
      );
      throw err;
    }
  }

  const auditAction = action === 'approve' ? 'join_request.approve' as const : 'join_request.reject' as const;
  await auditLog(auditAction, caller.userId, request.user_id, {
    communityDid: request.community_did,
  });

  return { status: newStatus };
}
