import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireAuth } from '../auth/guards.js';
import { canViewPrivateCommunity, getCommunityAccess } from '../community/visibility.js';
import {
  decodeActivityCursor,
  loadLocalActivity,
  mergeActivityPage,
  parseActivityLimit,
  InvalidActivityCursorError,
} from '../activity/feed.js';
import { MAX_COMMUNITIES_PER_CALL } from '../activity/remote.js';

/** Statuses whose activity is served. Taken-down, importing and moved copies are not. */
const SERVED_STATUSES = new Set(['active', 'suspended']);

/**
 * net.openfederation.activity.listCommunityActivity
 *
 * Merged recent activity of up to 25 communities hosted here. What a home PDS
 * calls, with a service-auth token for its account, to build that account's
 * timeline; any authenticated client may call it too.
 *
 * Privacy is decided here, per community, with the same rules as the other
 * community read endpoints: a public community for any authenticated caller,
 * a private one for members, its owner and PDS admins; join requests for the
 * owner and admins only. Every community that is not listed — whatever the
 * reason, including "does not exist" — comes back in `unavailable`, so the
 * answer does not tell a private community apart from a missing DID.
 */
export default async function listCommunityActivity(req: AuthRequest, res: Response): Promise<void> {
  if (!requireAuth(req, res)) return;

  const raw = req.query.community;
  const requested = [...new Set((Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]).map(String))];
  if (requested.length === 0 || requested.length > MAX_COMMUNITIES_PER_CALL || requested.some((d) => !d.startsWith('did:'))) {
    res.status(400).json({ error: 'InvalidRequest', message: `community must be 1 to ${MAX_COMMUNITIES_PER_CALL} DIDs` });
    return;
  }

  let cursor;
  try {
    cursor = decodeActivityCursor(req.query.cursor);
  } catch (err) {
    if (err instanceof InvalidActivityCursorError) {
      res.status(400).json({ error: 'InvalidRequest', message: 'cursor is not valid' });
      return;
    }
    throw err;
  }
  const limit = parseActivityLimit(req.query.limit);

  const access = await Promise.all(requested.map(async (did) => ({
    did,
    access: await getCommunityAccess({ communityDid: did, caller: req.auth }),
  })));

  const readable: string[] = [];
  const unavailable: string[] = [];
  const withJoinRequests = new Set<string>();
  for (const { did, access: a } of access) {
    const visible = a.exists
      && SERVED_STATUSES.has(a.status ?? '')
      && (a.visibility !== 'private' || canViewPrivateCommunity(a));
    if (!visible) {
      unavailable.push(did);
      continue;
    }
    readable.push(did);
    if (a.isOwner || a.isAdmin) withJoinRequests.add(did);
  }

  const lists = readable.length > 0 ? await loadLocalActivity(readable, withJoinRequests, limit + 1, cursor) : [];
  res.status(200).json({ ...mergeActivityPage(lists, limit, cursor), unavailable });
}
