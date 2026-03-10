import { Request, Response } from 'express';
import { config } from '../config.js';
import { getCachedPeerInfo } from '../federation/peer-cache.js';

/**
 * net.openfederation.federation.listPeers
 *
 * GET, no auth required.
 * Returns this PDS instance info plus known peer PDS servers with health status.
 */
export default async function listPeers(_req: Request, res: Response): Promise<void> {
  try {
    const peers = await getCachedPeerInfo();

    res.status(200).json({
      self: {
        hostname: config.pds.hostname,
        serviceUrl: config.pds.serviceUrl,
      },
      peers,
    });
  } catch (error) {
    console.error('Error listing peers:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to list peers' });
  }
}
