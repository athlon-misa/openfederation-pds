import { query, withTransaction } from '../db/client.js';

export const FORUM_THREAD = 'net.openfederation.forum.thread';
export const FORUM_POST = 'net.openfederation.forum.post';
export const CALENDAR_EVENT = 'community.lexicon.calendar.event';
export const CALENDAR_RSVP = 'community.lexicon.calendar.rsvp';

export async function indexThread(t: {
  uri: string; cid: string; communityDid: string; authorDid: string;
  title: string; tags: string[]; createdAt: string;
}): Promise<void> {
  await query(
    `INSERT INTO forum_threads (uri, cid, community_did, author_did, title, tags, post_count, last_activity, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, 0, $7, $7)
     ON CONFLICT (uri) DO UPDATE SET cid = $2, title = $5, tags = $6`,
    [t.uri, t.cid, t.communityDid, t.authorDid, t.title, t.tags, t.createdAt]
  );
}

export async function indexPost(p: {
  uri: string; cid: string; communityDid: string; authorDid: string;
  threadRootUri: string; parentUri: string | null;
  record: Record<string, unknown>; createdAt: string;
}): Promise<void> {
  await withTransaction(async (client) => {
    const existing = await client.query('SELECT 1 FROM forum_posts WHERE uri = $1', [p.uri]);
    await client.query(
      `INSERT INTO forum_posts (uri, cid, community_did, author_did, thread_root_uri, parent_uri, record, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (uri) DO UPDATE SET cid = $2, record = $7`,
      [p.uri, p.cid, p.communityDid, p.authorDid, p.threadRootUri, p.parentUri, JSON.stringify(p.record), p.createdAt]
    );
    if (existing.rows.length === 0) {
      await client.query(
        `UPDATE forum_threads
           SET post_count = post_count + 1,
               last_activity = GREATEST(last_activity, $2)
         WHERE uri = $1`,
        [p.threadRootUri, p.createdAt]
      );
    }
  });
}

export async function deindexPost(uri: string): Promise<void> {
  await withTransaction(async (client) => {
    const res = await client.query<{ thread_root_uri: string }>(
      'DELETE FROM forum_posts WHERE uri = $1 RETURNING thread_root_uri',
      [uri]
    );
    if (res.rows.length > 0) {
      await client.query(
        'UPDATE forum_threads SET post_count = GREATEST(post_count - 1, 0) WHERE uri = $1',
        [res.rows[0].thread_root_uri]
      );
    }
  });
}

export async function setPostHidden(uri: string, hidden: boolean): Promise<void> {
  await query('UPDATE forum_posts SET hidden = $2 WHERE uri = $1', [uri, hidden]);
}

export async function setThreadHidden(uri: string, hidden: boolean): Promise<void> {
  await query('UPDATE forum_threads SET hidden = $2 WHERE uri = $1', [uri, hidden]);
}

export async function indexRsvp(r: {
  uri: string; eventUri: string; attendeeDid: string; status: string; createdAt: string;
}): Promise<void> {
  await query(
    `INSERT INTO event_rsvps (uri, event_uri, attendee_did, status, created_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (event_uri, attendee_did)
     DO UPDATE SET uri = $1, status = $4, created_at = $5`,
    [r.uri, r.eventUri, r.attendeeDid, r.status, r.createdAt]
  );
}

/**
 * A keyset cursor: the sort timestamp at full precision plus a tie-breaker,
 * as `<timestamp>|<key>`. The timestamp is produced by Postgres as text, so it
 * round-trips exactly. (The old cursor was a JavaScript `Date` turned into a
 * string: it dropped sub-second precision, could not be parsed back by
 * Postgres outside UTC, and with no tie-breaker lost every other row that
 * shared the boundary's timestamp.)
 */
export function parseKeysetCursor(cursor: string | null): { ts: string; key: string | null } | null {
  if (!cursor) return null;
  const sep = cursor.indexOf('|');
  const ts = sep === -1 ? cursor : cursor.slice(0, sep);
  const key = sep === -1 ? null : cursor.slice(sep + 1);
  // Accept only what Postgres will certainly read as a timestamp.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/.test(ts)) return null;
  return { ts, key };
}

/** Thrown for a cursor this server did not hand out. */
export class InvalidCursorError extends Error {
  constructor() {
    super('cursor is not valid');
    this.name = 'InvalidCursorError';
  }
}

function requireCursor(cursor: string | null): { ts: string; key: string | null } | null {
  if (!cursor) return null;
  const parsed = parseKeysetCursor(cursor);
  if (!parsed) throw new InvalidCursorError();
  return parsed;
}

export async function listThreads(
  communityDid: string,
  limit: number,
  before: string | null,
  opts: { includeHidden?: boolean } = {}
): Promise<Array<Record<string, unknown>>> {
  const params: unknown[] = [communityDid, limit];
  let where = 'community_did = $1';
  if (!opts.includeHidden) where += ' AND hidden = false';
  const cursor = requireCursor(before);
  if (cursor) {
    params.push(cursor.ts, cursor.key ?? '');
    // Newest first, so the next page is what sorts below the cursor row.
    where += cursor.key === null
      ? ' AND last_activity < $3::timestamptz AND $4 = $4'
      : ' AND (last_activity, uri) < ($3::timestamptz, $4)';
  }
  const res = await query<Record<string, unknown>>(
    `SELECT uri, cid, community_did, author_did, title, tags, post_count, last_activity, created_at, hidden,
            to_char(last_activity AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') || '|' || uri AS page_cursor
     FROM forum_threads WHERE ${where} ORDER BY last_activity DESC, uri DESC LIMIT $2`,
    params
  );
  return res.rows;
}

export async function getThread(uri: string): Promise<Record<string, unknown> | null> {
  const res = await query<Record<string, unknown>>(
    `SELECT uri, cid, community_did, author_did, title, tags, post_count, last_activity, created_at, hidden
     FROM forum_threads WHERE uri = $1`,
    [uri]
  );
  return res.rows[0] ?? null;
}

export async function getThreadPosts(
  threadUri: string,
  limit: number,
  after: string | null,
  opts: { includeHidden?: boolean } = {}
): Promise<Array<Record<string, unknown>>> {
  const params: unknown[] = [threadUri, limit];
  let where = 'thread_root_uri = $1';
  if (!opts.includeHidden) where += ' AND hidden = false';
  const cursor = requireCursor(after);
  if (cursor) {
    params.push(cursor.ts, cursor.key ?? '');
    // Oldest first, so the next page is what sorts above the cursor row.
    where += cursor.key === null
      ? ' AND created_at > $3::timestamptz AND $4 = $4'
      : ' AND (created_at, uri) > ($3::timestamptz, $4)';
  }
  const res = await query<Record<string, unknown>>(
    `SELECT uri, cid, community_did, author_did, thread_root_uri, parent_uri, record, created_at, hidden,
            to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') || '|' || uri AS page_cursor
     FROM forum_posts WHERE ${where} ORDER BY created_at ASC, uri ASC LIMIT $2`,
    params
  );
  return res.rows;
}

export async function listRsvps(
  eventUri: string,
  limit = 100,
  after: string | null = null,
): Promise<{
  counts: Record<string, number>;
  rsvps: Array<{ attendeeDid: string; status: string; createdAt: string }>;
  cursor?: string;
}> {
  // Counts cover every RSVP; the list itself is a page of them.
  const tally = await query<{ status: string; n: string }>(
    'SELECT status, COUNT(*) AS n FROM event_rsvps WHERE event_uri = $1 GROUP BY status',
    [eventUri]
  );
  const counts: Record<string, number> = { going: 0, interested: 0, notgoing: 0 };
  for (const row of tally.rows) counts[row.status] = Number(row.n);

  const params: unknown[] = [eventUri, limit + 1];
  let where = 'event_uri = $1';
  const cursor = requireCursor(after);
  if (cursor) {
    params.push(cursor.ts, cursor.key ?? '');
    where += ' AND (created_at, attendee_did) > ($3::timestamptz, $4)';
  }
  const res = await query<{ attendee_did: string; status: string; created_at: string; page_cursor: string }>(
    `SELECT attendee_did, status, created_at,
            to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') || '|' || attendee_did AS page_cursor
     FROM event_rsvps WHERE ${where} ORDER BY created_at ASC, attendee_did ASC LIMIT $2`,
    params
  );
  const page = res.rows.slice(0, limit);
  const next = res.rows.length > limit ? page[page.length - 1].page_cursor : undefined;
  return {
    counts,
    rsvps: page.map(r => ({ attendeeDid: r.attendee_did, status: r.status, createdAt: r.created_at })),
    ...(next ? { cursor: next } : {}),
  };
}
