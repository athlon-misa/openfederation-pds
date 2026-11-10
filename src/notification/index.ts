import { query } from '../db/client.js';
import type { AuthContext } from '../auth/types.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The cursor a caller sent is not one this list hands out. */
export class InvalidCursorError extends Error {
  constructor() {
    super('cursor is not valid');
    this.name = 'InvalidCursorError';
  }
}

export async function createNotification(
  recipientDid: string,
  category: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await query(
    `INSERT INTO notifications (recipient_did, category, payload)
     VALUES ($1, $2, $3)`,
    [recipientDid, category, JSON.stringify(payload)],
  );
}

export async function listNotifications(
  auth: AuthContext,
  opts: { category?: string; unreadOnly?: boolean; limit: number; cursor?: string },
): Promise<{ notifications: unknown[]; cursor?: string }> {
  const { category, unreadOnly, limit, cursor } = opts;
  const callerDid = auth.did!;

  let sql = `SELECT id, category, payload, created_at, read_at
             FROM notifications
             WHERE recipient_did = $1`;
  const params: (string | number | boolean)[] = [callerDid];
  let idx = 2;

  if (category) {
    sql += ` AND category = $${idx++}`;
    params.push(category);
  }
  if (unreadOnly) {
    sql += ` AND read_at IS NULL`;
  }
  if (cursor) {
    // The cursor is the id of the last notification on the previous page. Ids
    // are random, so "id < cursor" is not "older than"; the page boundary is
    // that row's position in the (created_at, id) ordering the list uses.
    if (!UUID.test(cursor)) throw new InvalidCursorError();
    sql += ` AND (created_at, id) < (
               SELECT c.created_at, c.id FROM notifications c
               WHERE c.id = $${idx++}::uuid AND c.recipient_did = $1)`;
    params.push(cursor);
  }

  sql += ` ORDER BY created_at DESC, id DESC LIMIT $${idx}`;
  params.push(limit + 1);

  const result = await query<{
    id: string;
    category: string;
    payload: unknown;
    created_at: Date;
    read_at: Date | null;
  }>(sql, params);

  let rows = result.rows;
  let nextCursor: string | undefined;
  if (rows.length > limit) {
    rows = rows.slice(0, limit);
    nextCursor = rows[rows.length - 1].id;
  }

  return {
    notifications: rows.map(r => ({
      id: r.id,
      category: r.category,
      payload: r.payload,
      createdAt: new Date(r.created_at).toISOString(),
      ...(r.read_at ? { readAt: new Date(r.read_at).toISOString() } : {}),
    })),
    ...(nextCursor ? { cursor: nextCursor } : {}),
  };
}

export async function markNotificationsRead(
  auth: AuthContext,
  ids: string[] | 'all',
): Promise<number> {
  const callerDid = auth.did!;
  let result;
  if (ids === 'all') {
    result = await query(
      `UPDATE notifications SET read_at = NOW()
       WHERE recipient_did = $1 AND read_at IS NULL`,
      [callerDid],
    );
  } else {
    if (ids.length === 0) return 0;
    result = await query(
      `UPDATE notifications SET read_at = NOW()
       WHERE recipient_did = $1 AND id = ANY($2::uuid[]) AND read_at IS NULL`,
      [callerDid, ids],
    );
  }
  return result.rowCount ?? 0;
}

export async function unreadCount(
  auth: AuthContext,
): Promise<{ count: number; byCategory: Record<string, number> }> {
  const callerDid = auth.did!;
  const result = await query<{ category: string; cnt: string }>(
    `SELECT category, COUNT(*) as cnt
     FROM notifications
     WHERE recipient_did = $1 AND read_at IS NULL
     GROUP BY category`,
    [callerDid],
  );

  const byCategory: Record<string, number> = {};
  let total = 0;
  for (const row of result.rows) {
    const n = parseInt(row.cnt, 10);
    byCategory[row.category] = n;
    total += n;
  }
  return { count: total, byCategory };
}
