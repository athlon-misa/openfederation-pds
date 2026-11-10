import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { query } from '../db/client.js';
import { CALENDAR_EVENT, parseKeysetCursor, InvalidCursorError } from '../forum/forum-index.js';
import { requireCommunityReadable } from '../auth/guards.js';

export default async function listEvents(req: AuthRequest, res: Response): Promise<void> {
  try {
    const community = String(req.query.community || '');
    if (!community) {
      res.status(400).json({ error: 'InvalidRequest', message: 'community is required' });
      return;
    }
    if (!(await requireCommunityReadable(req, res, community))) return;
    // Newest first, a page at a time. This used to return the newest 200 and
    // nothing else, with no way to reach the rest.
    const limit = Math.min(Math.max(parseInt(String(req.query.limit || '200'), 10) || 200, 1), 200);
    const cursor = req.query.cursor ? parseKeysetCursor(String(req.query.cursor)) : null;
    if (req.query.cursor && (!cursor || cursor.key === null)) throw new InvalidCursorError();
    const rows = await query<{ rkey: string; cid: string; record: Record<string, unknown>; page_cursor: string }>(
      `SELECT rkey, cid, record,
              to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') || '|' || rkey AS page_cursor
       FROM records_index
       WHERE community_did = $1 AND collection = $2
         AND ($4::text IS NULL OR (created_at, rkey) < ($4::timestamptz, $5))
       ORDER BY created_at DESC, rkey DESC LIMIT $3`,
      [community, CALENDAR_EVENT, limit + 1, cursor?.ts ?? null, cursor?.key ?? null]
    );
    const page = rows.rows.slice(0, limit);
    const events = page.map((r) => ({
      uri: `at://${community}/${CALENDAR_EVENT}/${r.rkey}`, cid: r.cid, record: r.record,
    }));
    const next = rows.rows.length > limit ? page[page.length - 1].page_cursor : undefined;
    res.status(200).json({ events, ...(next ? { cursor: next } : {}) });
  } catch (error) {
    if (error instanceof InvalidCursorError) {
      res.status(400).json({ error: 'InvalidRequest', message: 'cursor is not valid' });
      return;
    }
    console.error('Error in calendar.listEvents:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to list events' });
  }
}
