import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireAuth } from '../auth/guards.js';
import { query } from '../db/client.js';
import { RepoEngine } from '../repo/repo-engine.js';
import { getKeypairForDid } from '../repo/keypair-utils.js';
import { auditLog } from '../db/audit.js';

/**
 * net.openfederation.community.resolveJoinRequest
 *
 * Approve or reject a pending join request. Owner or admin only.
 */
export default async function resolveJoinRequest(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireAuth(req, res)) {
      return;
    }

    const { requestId, action } = req.body;

    if (!requestId || !action) {
      res.status(400).json({ error: 'InvalidRequest', message: 'Missing required fields: requestId and action' });
      return;
    }

    if (!['approve', 'reject'].includes(action)) {
      res.status(400).json({ error: 'InvalidRequest', message: 'action must be "approve" or "reject"' });
      return;
    }

    // Fetch the join request
    const requestResult = await query<{
      id: string;
      community_did: string;
      user_id: string;
      user_did: string;
      status: string;
    }>(
      'SELECT id, community_did, user_id, user_did, status FROM join_requests WHERE id = $1',
      [requestId]
    );

    if (requestResult.rows.length === 0) {
      res.status(404).json({ error: 'NotFound', message: 'Join request not found' });
      return;
    }

    const request = requestResult.rows[0];

    if (request.status !== 'pending') {
      res.status(400).json({ error: 'AlreadyResolved', message: 'This join request has already been resolved' });
      return;
    }

    // Verify authorization: owner or admin
    const communityResult = await query<{ created_by: string }>(
      'SELECT created_by FROM communities WHERE did = $1',
      [request.community_did]
    );
    if (communityResult.rows.length === 0) {
      res.status(404).json({ error: 'NotFound', message: 'Community not found' });
      return;
    }

    const isOwner = communityResult.rows[0].created_by === req.auth.userId;
    const isAdmin = req.auth.roles.includes('admin');

    if (!isOwner && !isAdmin) {
      res.status(403).json({ error: 'Forbidden', message: 'Only the community owner or admin can resolve join requests' });
      return;
    }

    const newStatus = action === 'approve' ? 'approved' : 'rejected';

    // Update the request
    await query(
      `UPDATE join_requests SET status = $1, resolved_by = $2, resolved_at = CURRENT_TIMESTAMP WHERE id = $3`,
      [newStatus, req.auth.userId, requestId]
    );

    // If approved, add as member
    if (action === 'approve') {
      // Get the user's handle
      const userResult = await query<{ handle: string }>(
        'SELECT handle FROM users WHERE id = $1',
        [request.user_id]
      );
      const handle = userResult.rows[0]?.handle || 'unknown';

      const engine = new RepoEngine(request.community_did);
      const keypair = await getKeypairForDid(request.community_did);
      const rkey = RepoEngine.generateTid();
      await engine.putRecord(keypair, 'net.openfederation.community.member', rkey, {
        did: request.user_did,
        handle,
        role: 'member',
        joinedAt: new Date().toISOString(),
      });
    }

    const auditAction = action === 'approve' ? 'join_request.approve' as const : 'join_request.reject' as const;
    await auditLog(auditAction, req.auth.userId, request.user_id, {
      communityDid: request.community_did,
    });

    res.status(200).json({ status: newStatus });
  } catch (error) {
    console.error('Error resolving join request:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to resolve join request' });
  }
}
