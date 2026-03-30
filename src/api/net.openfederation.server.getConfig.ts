import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireRole } from '../auth/guards.js';
import { query } from '../db/client.js';
import { config } from '../config.js';

export default async function getServerConfig(req: AuthRequest, res: Response): Promise<void> {
  if (!requireRole(req, res, ['admin', 'auditor'])) {
    return;
  }

  try {
    const [usersResult, communitiesResult, invitesResult] = await Promise.all([
      query<{ total: string; pending: string; approved: string }>(
        `SELECT
           COUNT(*)::text as total,
           COUNT(*) FILTER (WHERE status = 'pending')::text as pending,
           COUNT(*) FILTER (WHERE status = 'approved')::text as approved
         FROM users`
      ),
      query<{ total: string; active: string; suspended: string }>(
        `SELECT
           COUNT(*)::text as total,
           COUNT(*) FILTER (WHERE status = 'active')::text as active,
           COUNT(*) FILTER (WHERE status = 'suspended')::text as suspended
         FROM communities`
      ),
      query<{ total: string; active: string }>(
        `SELECT
           COUNT(*)::text as total,
           COUNT(*) FILTER (WHERE uses_count < max_uses AND (expires_at IS NULL OR expires_at > NOW()))::text as active
         FROM invites`
      ),
    ]);

    const users = usersResult.rows[0];
    const communities = communitiesResult.rows[0];
    const invites = invitesResult.rows[0];

    res.status(200).json({
      service: 'OpenFederation PDS',
      version: '1.0.0',
      hostname: config.pds.hostname,
      inviteRequired: config.auth.inviteRequired,
      stats: {
        totalUsers: parseInt(users.total, 10),
        pendingUsers: parseInt(users.pending, 10),
        approvedUsers: parseInt(users.approved, 10),
        totalCommunities: parseInt(communities.total, 10),
        activeCommunities: parseInt(communities.active, 10),
        suspendedCommunities: parseInt(communities.suspended, 10),
        totalInvites: parseInt(invites.total, 10),
        activeInvites: parseInt(invites.active, 10),
      },
    });
  } catch (error) {
    console.error('Error getting server config:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to get server config' });
  }
}
