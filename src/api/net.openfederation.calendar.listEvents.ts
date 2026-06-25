import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { query } from '../db/client.js';
import { CALENDAR_EVENT } from '../forum/forum-index.js';

export default async function listEvents(req: AuthRequest, res: Response): Promise<void> {
  try {
    const community = String(req.query.community || '');
    if (!community) {
      res.status(400).json({ error: 'InvalidRequest', message: 'community is required' });
      return;
    }
    const rows = await query<{ rkey: string; cid: string; record: Record<string, unknown> }>(
      `SELECT rkey, cid, record FROM records_index
       WHERE community_did = $1 AND collection = $2
       ORDER BY created_at DESC LIMIT 200`,
      [community, CALENDAR_EVENT]
    );
    const events = rows.rows.map((r) => ({
      uri: `at://${community}/${CALENDAR_EVENT}/${r.rkey}`, cid: r.cid, record: r.record,
    }));
    res.status(200).json({ events });
  } catch (error) {
    console.error('Error in calendar.listEvents:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to list events' });
  }
}
