import { Request, Response } from 'express';
import { query } from '../db/client.js';
import { config } from '../config.js';

/**
 * net.openfederation.server.getPublicConfig
 *
 * GET, no auth required.
 * Returns basic server info and public stats for peer discovery.
 */
export default async function getPublicConfig(_req: Request, res: Response): Promise<void> {
  try {
    const [activeCommunitiesResult, totalUsersResult] = await Promise.all([
      query<{ count: string }>("SELECT COUNT(*) as count FROM communities WHERE status = 'active'"),
      query<{ count: string }>("SELECT COUNT(*) as count FROM users WHERE status = 'approved'"),
    ]);

    res.status(200).json({
      service: 'OpenFederation PDS',
      version: '1.0.0',
      hostname: config.pds.hostname,
      serviceUrl: config.pds.serviceUrl,
      webUrl: config.federation.webUiUrl || null,
      stats: {
        activeCommunities: parseInt(activeCommunitiesResult.rows[0].count, 10),
        totalUsers: parseInt(totalUsersResult.rows[0].count, 10),
      },
    });
  } catch (error) {
    console.error('Error getting public config:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to get server info' });
  }
}
