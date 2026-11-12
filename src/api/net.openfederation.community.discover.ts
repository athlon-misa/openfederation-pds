import type { Request, Response } from 'express';
import { discoverCommunities } from '../federation/community-discovery.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const MAX_QUERY_LENGTH = 100;

/**
 * net.openfederation.community.discover
 *
 * GET, no auth. Public communities on this server and on every peer named in
 * FEDERATION_PEERS, deduplicated by DID (#41). `peers` says which peers
 * answered, so a client can say "2 servers didn't answer". A peer that fails
 * never fails the request.
 *
 * `cursor` is opaque to clients (today a position in the merged list, which
 * is stable while the peer cache is). `q` filters on handle, display name and
 * description, case-insensitively.
 */
export default async function discover(req: Request, res: Response): Promise<void> {
  const limitRaw = req.query.limit;
  const cursorRaw = req.query.cursor;
  const qRaw = req.query.q;

  let limit = DEFAULT_LIMIT;
  if (limitRaw !== undefined) {
    const n = Number(limitRaw);
    if (typeof limitRaw !== 'string' || !Number.isInteger(n) || n < 1 || n > MAX_LIMIT) {
      res.status(400).json({ error: 'InvalidRequest', message: `limit must be an integer from 1 to ${MAX_LIMIT}` });
      return;
    }
    limit = n;
  }

  let offset = 0;
  if (cursorRaw !== undefined && cursorRaw !== '') {
    if (typeof cursorRaw !== 'string' || !/^\d{1,9}$/.test(cursorRaw)) {
      res.status(400).json({ error: 'InvalidRequest', message: 'Invalid cursor' });
      return;
    }
    offset = Number(cursorRaw);
  }

  if (qRaw !== undefined && (typeof qRaw !== 'string' || qRaw.length > MAX_QUERY_LENGTH)) {
    res.status(400).json({ error: 'InvalidRequest', message: `q must be a string of at most ${MAX_QUERY_LENGTH} characters` });
    return;
  }
  const q = typeof qRaw === 'string' ? qRaw.trim().toLowerCase() : '';

  try {
    const { communities, peers } = await discoverCommunities();
    const matching = q
      ? communities.filter((c) =>
        c.handle.toLowerCase().includes(q) ||
        c.displayName.toLowerCase().includes(q) ||
        c.description.toLowerCase().includes(q))
      : communities;

    const page = matching.slice(offset, offset + limit);
    const next = offset + limit;
    res.status(200).json({
      communities: page,
      ...(next < matching.length ? { cursor: String(next) } : {}),
      peers,
    });
  } catch (error) {
    console.error('Error discovering communities:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to discover communities' });
  }
}
