import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireAuth, requireLocalAccount } from '../auth/guards.js';
import { decodeActivityCursor, parseActivityLimit, InvalidActivityCursorError } from '../activity/feed.js';
import { buildUserTimeline } from '../activity/timeline.js';

/**
 * net.openfederation.activity.getUserTimeline
 *
 * Recent activity across every community the caller belongs to, here and on
 * configured peer PDSes, newest first. See src/activity/timeline.ts.
 */
export default async function getUserTimeline(req: AuthRequest, res: Response): Promise<void> {
  if (!requireAuth(req, res)) return;
  if (!requireLocalAccount(req, res)) return;
  // The timeline asks other servers with tokens signed for the caller. A
  // service-auth token is itself another server speaking for the account; it
  // does not get to have this one sign more tokens (as getServiceAuth).
  if (req.auth.authMethod === 'service-auth') {
    res.status(403).json({ error: 'Forbidden', message: 'getUserTimeline cannot be called with service-auth.' });
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
  const rawCursor = cursor ? String(req.query.cursor) : undefined;

  const timeline = await buildUserTimeline(req.auth, limit, cursor, rawCursor);
  res.status(200).json(timeline);
}
