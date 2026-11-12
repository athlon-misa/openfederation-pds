import { Request, Response } from 'express';
import { getCachedPeerCommunities, getCachedPeerInfo } from '../federation/peer-cache.js';
import { query } from '../db/client.js';

/**
 * net.openfederation.federation.listPeerCommunities
 *
 * @deprecated Deprecation: superseded by net.openfederation.community.discover
 * (#41), which lists this server's public communities and its peers' together,
 * with where each lives and which peers answered. Kept for existing clients;
 * the dashboard no longer calls it. Do not remove without a release note.
 *
 * GET, no auth required.
 * Returns communities from all configured peer PDS servers, plus peer health info.
 * A peer never speaks for a community hosted here, public or private: its
 * entries for our DIDs are dropped (as in community.discover, #41).
 */
export default async function listPeerCommunities(_req: Request, res: Response): Promise<void> {
  try {
    const [communitiesResult, peers] = await Promise.all([
      getCachedPeerCommunities(),
      getCachedPeerInfo(),
    ]);

    const dids = communitiesResult.communities.map((c) => c.did);
    const hostedHere = new Set<string>();
    if (dids.length > 0) {
      const hosted = await query<{ did: string }>('SELECT did FROM communities WHERE did = ANY($1)', [dids]);
      for (const row of hosted.rows) hostedHere.add(row.did);
    }

    res.status(200).json({
      communities: communitiesResult.communities.filter((c) => !hostedHere.has(c.did)),
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
