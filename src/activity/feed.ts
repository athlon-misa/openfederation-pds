/**
 * Community activity: what happened in a community, read from what the
 * community already stores (#42). Nothing is written to produce it — no
 * activity records, no push index. Each entry is built from one of:
 *
 *   member.joined         members_unique (+ the member record's CID)
 *   joinRequest.created   join_requests, pending; owner and PDS admins only
 *   proposal.created      records_index, net.openfederation.community.proposal
 *   event.created         records_index, community.lexicon.calendar.event
 *   forum.thread.created  forum_threads, not hidden
 *
 * Order is newest first by the time this PDS recorded the row (microsecond
 * precision), then by `id` in byte order, so the order is total and a cursor
 * (`createdAt|id`) is stable when entries share a timestamp. The same order
 * is used in SQL (COLLATE "C") and when merging in JavaScript.
 *
 * Who may see what is NOT decided here: callers pass only the communities
 * the viewer may read, and the communities where they may see join requests.
 */
import { query } from '../db/client.js';
import { MEMBER_COLLECTION } from '../auth/permissions.js';
import { PROPOSAL_COLLECTION } from '../governance/decision-rules.js';
import { CALENDAR_EVENT } from '../forum/forum-index.js';

export const ACTIVITY_KINDS = [
  'member.joined',
  'joinRequest.created',
  'proposal.created',
  'event.created',
  'forum.thread.created',
] as const;

export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

export interface ActivitySummary {
  handle?: string;
  role?: string;
  title?: string;
  name?: string;
  startsAt?: string;
  action?: string;
  targetCollection?: string;
  status?: string;
}

export interface ActivityEntry {
  id: string;
  kind: string;
  community: string;
  actor?: string;
  uri?: string;
  cid?: string;
  /** UTC, always `YYYY-MM-DDTHH:MM:SS.ffffffZ`, so string order is time order. */
  createdAt: string;
  summary?: ActivitySummary;
}

export interface ActivityCursor {
  ts: string;
  id: string;
}

export const MAX_ACTIVITY_LIMIT = 100;
export const DEFAULT_ACTIVITY_LIMIT = 30;
const MAX_ID_LENGTH = 512;

/** Thrown for a cursor this server did not hand out. */
export class InvalidActivityCursorError extends Error {
  constructor() {
    super('cursor is not valid');
    this.name = 'InvalidActivityCursorError';
  }
}

export function parseActivityLimit(raw: unknown): number {
  const n = parseInt(String(raw ?? DEFAULT_ACTIVITY_LIMIT), 10);
  if (!Number.isFinite(n)) return DEFAULT_ACTIVITY_LIMIT;
  return Math.min(Math.max(n, 1), MAX_ACTIVITY_LIMIT);
}

/**
 * Normalize a timestamp to `YYYY-MM-DDTHH:MM:SS.ffffffZ`, or null when it is
 * not a UTC ISO timestamp. Accepts 0–6 fractional digits (what another PDS,
 * or an older one, might send) and pads, so string comparison is exact.
 */
export function normalizeActivityTimestamp(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z$/.exec(raw);
  if (!m) return null;
  if (Number.isNaN(Date.parse(`${m[1]}Z`))) return null;
  return `${m[1]}.${(m[2] ?? '').padEnd(6, '0')}Z`;
}

export function encodeActivityCursor(entry: Pick<ActivityEntry, 'createdAt' | 'id'>): string {
  return Buffer.from(`${entry.createdAt}|${entry.id}`, 'utf-8').toString('base64url');
}

export function decodeActivityCursor(raw: unknown): ActivityCursor | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string' || raw.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(raw)) {
    throw new InvalidActivityCursorError();
  }
  const text = Buffer.from(raw, 'base64url').toString('utf-8');
  const sep = text.indexOf('|');
  if (sep === -1) throw new InvalidActivityCursorError();
  const ts = normalizeActivityTimestamp(text.slice(0, sep));
  const id = text.slice(sep + 1);
  if (!ts || id.length === 0 || id.length > MAX_ID_LENGTH) throw new InvalidActivityCursorError();
  return { ts, id };
}

/** Byte-order comparison, matching COLLATE "C" in Postgres. */
function compareBytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf-8'), Buffer.from(b, 'utf-8'));
}

/** Newest first; ties broken by id, descending. */
export function compareActivity(a: ActivityEntry, b: ActivityEntry): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  return -compareBytes(a.id, b.id);
}

/** True when the entry sorts after the cursor, i.e. belongs on a later page. */
export function isAfterCursor(entry: ActivityEntry, cursor: ActivityCursor | null): boolean {
  if (!cursor) return true;
  if (entry.createdAt !== cursor.ts) return entry.createdAt < cursor.ts;
  return compareBytes(entry.id, cursor.id) < 0;
}

/**
 * Merge per-source lists into one page. Each source must have returned its
 * newest `limit + 1` entries after the cursor (or all it has): then the
 * page's `limit` entries are exactly the global newest, and there is a next
 * page iff more than `limit` entries were seen.
 */
export function mergeActivityPage(
  sources: ActivityEntry[][],
  limit: number,
  cursor: ActivityCursor | null,
): { entries: ActivityEntry[]; cursor?: string } {
  const seen = new Set<string>();
  const all: ActivityEntry[] = [];
  for (const list of sources) {
    for (const entry of list) {
      if (seen.has(entry.id) || !isAfterCursor(entry, cursor)) continue;
      seen.add(entry.id);
      all.push(entry);
    }
  }
  all.sort(compareActivity);
  const entries = all.slice(0, limit);
  return all.length > limit
    ? { entries, cursor: encodeActivityCursor(entries[entries.length - 1]) }
    : { entries };
}

// ── Local feeds ──────────────────────────────────────────────────────────────

type ActivityRow = {
  kind: string;
  community: string;
  actor: string | null;
  id: string;
  uri: string | null;
  cid: string | null;
  created_at: string;
  summary: ActivitySummary | null;
};

const TS = `to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/**
 * One query for any number of communities: every source, filtered by the
 * cursor, then the newest `perCommunity` per community (window function), so
 * each community's list is complete enough to merge and to cache on its own.
 */
async function queryLocalActivity(
  communities: string[],
  joinRequestCommunities: string[],
  perCommunity: number,
  cursor: ActivityCursor | null,
): Promise<ActivityRow[]> {
  const result = await query<ActivityRow>(
    `WITH acts AS (
       SELECT 'member.joined'::text AS kind, mu.community_did AS community, mu.member_did AS actor,
              'at://' || mu.community_did || '/' || $6 || '/' || mu.record_rkey AS id,
              'at://' || mu.community_did || '/' || $6 || '/' || mu.record_rkey AS uri,
              ri.cid, mu.created_at AS at,
              jsonb_strip_nulls(jsonb_build_object('handle', mu.handle, 'role', mu.role)) AS summary
         FROM members_unique mu
         LEFT JOIN records_index ri
           ON ri.community_did = mu.community_did AND ri.collection = $6 AND ri.rkey = mu.record_rkey
        WHERE mu.community_did = ANY($1::text[])
       UNION ALL
       SELECT 'joinRequest.created', jr.community_did, jr.user_did,
              'joinRequest:' || jr.community_did || ':' || jr.id, NULL, NULL, jr.created_at,
              jsonb_strip_nulls(jsonb_build_object('handle', u.handle))
         FROM join_requests jr
         LEFT JOIN users u ON u.id = jr.user_id
        WHERE jr.community_did = ANY($2::text[]) AND jr.status = 'pending'
       UNION ALL
       SELECT 'proposal.created', ri.community_did, ri.record->>'proposedBy',
              'at://' || ri.community_did || '/' || ri.collection || '/' || ri.rkey,
              'at://' || ri.community_did || '/' || ri.collection || '/' || ri.rkey,
              ri.cid, ri.created_at,
              jsonb_strip_nulls(jsonb_build_object(
                'action', ri.record->>'action',
                'targetCollection', ri.record->>'targetCollection',
                'status', ri.record->>'status'))
         FROM records_index ri
        WHERE ri.community_did = ANY($1::text[]) AND ri.collection = $7
       UNION ALL
       SELECT 'event.created', ri.community_did, NULL,
              'at://' || ri.community_did || '/' || ri.collection || '/' || ri.rkey,
              'at://' || ri.community_did || '/' || ri.collection || '/' || ri.rkey,
              ri.cid, ri.created_at,
              jsonb_strip_nulls(jsonb_build_object(
                'name', ri.record->>'name',
                'startsAt', ri.record->>'startsAt',
                'status', ri.record->>'status'))
         FROM records_index ri
        WHERE ri.community_did = ANY($1::text[]) AND ri.collection = $8
       UNION ALL
       SELECT 'forum.thread.created', ft.community_did, ft.author_did, ft.uri, ft.uri, ft.cid, ft.created_at,
              jsonb_build_object('title', ft.title)
         FROM forum_threads ft
        WHERE ft.community_did = ANY($1::text[]) AND ft.hidden = false
     ),
     ranked AS (
       SELECT *, ROW_NUMBER() OVER (PARTITION BY community ORDER BY at DESC, id COLLATE "C" DESC) AS rn
         FROM acts
        WHERE $3::timestamptz IS NULL OR at < $3::timestamptz
           OR (at = $3::timestamptz AND id COLLATE "C" < $4::text COLLATE "C")
     )
     SELECT kind, community, actor, id, uri, cid, ${TS} AS created_at, summary
       FROM ranked WHERE rn <= $5`,
    [
      communities,
      joinRequestCommunities,
      cursor?.ts ?? null,
      cursor?.id ?? '',
      perCommunity,
      MEMBER_COLLECTION,
      PROPOSAL_COLLECTION,
      CALENDAR_EVENT,
    ],
  );
  return result.rows;
}

function rowToEntry(row: ActivityRow): ActivityEntry {
  const entry: ActivityEntry = { id: row.id, kind: row.kind, community: row.community, createdAt: row.created_at };
  if (row.actor) entry.actor = row.actor;
  if (row.uri) entry.uri = row.uri;
  if (row.cid) entry.cid = row.cid;
  if (row.summary && Object.keys(row.summary).length > 0) entry.summary = row.summary;
  return entry;
}

// A short-lived cache of each community's feed, keyed by what shapes it:
// community, whether join requests are in it, the page asked for. The access
// check happens per request, before the cache is consulted, so a cached feed
// is only ever handed to a viewer who may read that community — and the
// content is the same for every such viewer (join requests aside, which are
// part of the key).
const FEED_CACHE_TTL_MS = 10_000;
const FEED_CACHE_MAX = 2_000;
const feedCache = new Map<string, { at: number; entries: ActivityEntry[] }>();

function feedKey(community: string, withJoinRequests: boolean, perCommunity: number, cursor: ActivityCursor | null): string {
  return `${community}\u0000${withJoinRequests ? 1 : 0}\u0000${perCommunity}\u0000${cursor ? `${cursor.ts}|${cursor.id}` : ''}`;
}

function cacheGet(key: string): ActivityEntry[] | undefined {
  const hit = feedCache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > FEED_CACHE_TTL_MS) {
    feedCache.delete(key);
    return undefined;
  }
  return hit.entries;
}

function cacheSet(key: string, entries: ActivityEntry[]): void {
  while (feedCache.size >= FEED_CACHE_MAX) {
    const oldest = feedCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    feedCache.delete(oldest);
  }
  feedCache.set(key, { at: Date.now(), entries });
}

/** Test seam: forget every cached feed. */
export function _clearActivityFeedCache(): void {
  feedCache.clear();
}

/**
 * The newest `perCommunity` entries after `cursor` for each community hosted
 * here. The caller has already decided the viewer may read every community in
 * `communities`, and may see join requests in `joinRequestCommunities`.
 */
export async function loadLocalActivity(
  communities: string[],
  joinRequestCommunities: Set<string>,
  perCommunity: number,
  cursor: ActivityCursor | null,
): Promise<ActivityEntry[][]> {
  const lists: ActivityEntry[][] = [];
  const misses: string[] = [];
  for (const community of communities) {
    const cached = cacheGet(feedKey(community, joinRequestCommunities.has(community), perCommunity, cursor));
    if (cached) lists.push(cached);
    else misses.push(community);
  }
  if (misses.length === 0) return lists;

  const rows = await queryLocalActivity(
    misses,
    misses.filter((c) => joinRequestCommunities.has(c)),
    perCommunity,
    cursor,
  );
  const byCommunity = new Map<string, ActivityEntry[]>(misses.map((c) => [c, []]));
  for (const row of rows) byCommunity.get(row.community)?.push(rowToEntry(row));
  for (const [community, entries] of byCommunity) {
    entries.sort(compareActivity);
    cacheSet(feedKey(community, joinRequestCommunities.has(community), perCommunity, cursor), entries);
    lists.push(entries);
  }
  return lists;
}

// ── Entries from another PDS ─────────────────────────────────────────────────

const MAX_FIELD = 300;
const SUMMARY_FIELDS: Array<keyof ActivitySummary> = [
  'handle', 'role', 'title', 'name', 'startsAt', 'action', 'targetCollection', 'status',
];

function shortString(value: unknown, max = MAX_FIELD): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, max) : undefined;
}

/**
 * Accept an entry another PDS sent only if it is well formed and belongs to
 * one of the communities we asked it about. A peer cannot slip in activity
 * for a community it was not asked about, and nothing it sends is passed on
 * unbounded.
 */
export function sanitizeRemoteEntry(raw: unknown, allowed: Set<string>): ActivityEntry | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const community = typeof r.community === 'string' ? r.community : '';
  if (!allowed.has(community)) return null;
  const id = shortString(r.id, MAX_ID_LENGTH);
  const kind = shortString(r.kind, 64);
  const createdAt = normalizeActivityTimestamp(r.createdAt);
  if (!id || !kind || !/^[A-Za-z0-9.]+$/.test(kind) || !createdAt) return null;

  const entry: ActivityEntry = { id, kind, community, createdAt };
  const actor = shortString(r.actor);
  if (actor?.startsWith('did:')) entry.actor = actor;
  const uri = shortString(r.uri, MAX_ID_LENGTH);
  // Not necessarily in the community's repo: a public community's forum
  // thread lives in its author's.
  if (uri?.startsWith('at://did:')) entry.uri = uri;
  const cid = shortString(r.cid, 128);
  if (cid) entry.cid = cid;
  if (typeof r.summary === 'object' && r.summary !== null && !Array.isArray(r.summary)) {
    const s = r.summary as Record<string, unknown>;
    const summary: ActivitySummary = {};
    for (const field of SUMMARY_FIELDS) {
      const v = shortString(s[field]);
      if (v) summary[field] = v;
    }
    if (Object.keys(summary).length > 0) entry.summary = summary;
  }
  return entry;
}
