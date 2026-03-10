import { Request, Response } from 'express';
import { getCachedPeerCommunities, getCachedPeerInfo } from '../federation/peer-cache.js';

/**
 * net.openfederation.federation.listPeerCommunities
 *
 * GET, no auth required.
 * Returns communities from all configured peer PDS servers, plus peer health info.
 */
export default async function listPeerCommunities(_req: Request, res: Response): Promise<void> {
  try {
    const [communitiesResult, peers] = await Promise.all([
      getCachedPeerCommunities(),
      getCachedPeerInfo(),
    ]);

    res.status(200).json({
      communities: communitiesResult.communities,
      peers,
      cachedAt: communitiesResult.cachedAt
        ? new Date(communitiesResult.cachedAt).toISOString()
        : null,
    });
  } catch (error) {
    console.error('Error listing peer communities:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to list peer communities' });
  }
}
