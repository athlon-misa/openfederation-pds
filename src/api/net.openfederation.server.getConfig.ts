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
    const [
      totalUsersResult,
      pendingUsersResult,
      approvedUsersResult,
      totalCommunitiesResult,
      activeCommunitiesResult,
      suspendedCommunitiesResult,
      totalInvitesResult,
      activeInvitesResult,
    ] = await Promise.all([
      query<{ count: string }>('SELECT COUNT(*) as count FROM users'),
      query<{ count: string }>("SELECT COUNT(*) as count FROM users WHERE status = 'pending'"),
      query<{ count: string }>("SELECT COUNT(*) as count FROM users WHERE status = 'approved'"),
      query<{ count: string }>('SELECT COUNT(*) as count FROM communities'),
      query<{ count: string }>("SELECT COUNT(*) as count FROM communities WHERE status = 'active'"),
      query<{ count: string }>("SELECT COUNT(*) as count FROM communities WHERE status = 'suspended'"),
      query<{ count: string }>('SELECT COUNT(*) as count FROM invites'),
      query<{ count: string }>(
        "SELECT COUNT(*) as count FROM invites WHERE uses_count < max_uses AND (expires_at IS NULL OR expires_at > NOW())"
      ),
    ]);

    res.status(200).json({
      service: 'OpenFederation PDS',
      version: '1.0.0',
      hostname: config.pds.hostname,
      inviteRequired: config.auth.inviteRequired,
      stats: {
        totalUsers: parseInt(totalUsersResult.rows[0].count, 10),
        pendingUsers: parseInt(pendingUsersResult.rows[0].count, 10),
        approvedUsers: parseInt(approvedUsersResult.rows[0].count, 10),
        totalCommunities: parseInt(totalCommunitiesResult.rows[0].count, 10),
        activeCommunities: parseInt(activeCommunitiesResult.rows[0].count, 10),
        suspendedCommunities: parseInt(suspendedCommunitiesResult.rows[0].count, 10),
        totalInvites: parseInt(totalInvitesResult.rows[0].count, 10),
        activeInvites: parseInt(activeInvitesResult.rows[0].count, 10),
      },
    });
  } catch (error) {
    console.error('Error getting server config:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to get server config' });
  }
}
