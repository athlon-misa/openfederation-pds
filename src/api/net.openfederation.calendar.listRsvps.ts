import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { listRsvps, InvalidCursorError } from '../forum/forum-index.js';
import { requireCommunityReadable } from '../auth/guards.js';

export default async function listRsvpsHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const event = String(req.query.event || '');
    if (!event) {
      res.status(400).json({ error: 'InvalidRequest', message: 'event is required' });
      return;
    }
    // Events live in the community repo, so the event URI authority is the
    // community DID. Gate RSVP visibility (which exposes member DIDs) on it.
    const community = event.match(/^at:\/\/([^/]+)\//)?.[1];
    if (!community) {
      res.status(400).json({ error: 'InvalidRequest', message: 'event must be an at:// URI' });
      return;
    }
    if (!(await requireCommunityReadable(req, res, community))) return;
    const limit = Math.min(Math.max(parseInt(String(req.query.limit || '100'), 10) || 100, 1), 500);
    const after = req.query.cursor ? String(req.query.cursor) : null;
    res.status(200).json(await listRsvps(event, limit, after));
  } catch (error) {
    if (error instanceof InvalidCursorError) {
      res.status(400).json({ error: 'InvalidRequest', message: 'cursor is not valid' });
      return;
    }
    console.error('Error in calendar.listRsvps:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to list RSVPs' });
  }
}
