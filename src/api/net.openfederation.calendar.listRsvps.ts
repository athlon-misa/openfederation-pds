import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { listRsvps } from '../forum/forum-index.js';

export default async function listRsvpsHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const event = String(req.query.event || '');
    if (!event) {
      res.status(400).json({ error: 'InvalidRequest', message: 'event is required' });
      return;
    }
    const { counts, rsvps } = await listRsvps(event);
    res.status(200).json({ counts, rsvps });
  } catch (error) {
    console.error('Error in calendar.listRsvps:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to list RSVPs' });
  }
}
