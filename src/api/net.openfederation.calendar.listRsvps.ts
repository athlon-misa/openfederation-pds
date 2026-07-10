import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { listRsvps } from '../forum/forum-index.js';
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
    const { counts, rsvps } = await listRsvps(event);
    res.status(200).json({ counts, rsvps });
  } catch (error) {
    console.error('Error in calendar.listRsvps:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to list RSVPs' });
  }
}
