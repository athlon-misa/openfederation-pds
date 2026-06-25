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

export async function listThreads(
  communityDid: string,
  limit: number,
  before: string | null
): Promise<Array<Record<string, unknown>>> {
  const params: unknown[] = [communityDid, limit];
  let where = 'community_did = $1 AND hidden = false';
  if (before) {
    params.push(before);
    where += ` AND last_activity < $3`;
  }
  const res = await query<Record<string, unknown>>(
    `SELECT uri, cid, community_did, author_did, title, tags, post_count, last_activity, created_at
     FROM forum_threads WHERE ${where} ORDER BY last_activity DESC LIMIT $2`,
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
  after: string | null
): Promise<Array<Record<string, unknown>>> {
  const params: unknown[] = [threadUri, limit];
  let where = 'thread_root_uri = $1 AND hidden = false';
  if (after) {
    params.push(after);
    where += ` AND created_at > $3`;
  }
  const res = await query<Record<string, unknown>>(
    `SELECT uri, cid, community_did, author_did, thread_root_uri, parent_uri, record, created_at
     FROM forum_posts WHERE ${where} ORDER BY created_at ASC LIMIT $2`,
    params
  );
  return res.rows;
}

export async function listRsvps(eventUri: string): Promise<{
  counts: Record<string, number>;
  rsvps: Array<{ attendeeDid: string; status: string; createdAt: string }>;
}> {
  const res = await query<{ attendee_did: string; status: string; created_at: string }>(
    'SELECT attendee_did, status, created_at FROM event_rsvps WHERE event_uri = $1 ORDER BY created_at ASC',
    [eventUri]
  );
  const counts: Record<string, number> = { going: 0, interested: 0, notgoing: 0 };
  for (const row of res.rows) {
    counts[row.status] = (counts[row.status] ?? 0) + 1;
  }
  return {
    counts,
    rsvps: res.rows.map(r => ({ attendeeDid: r.attendee_did, status: r.status, createdAt: r.created_at })),
  };
}
