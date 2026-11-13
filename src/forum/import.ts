/**
 * Importing a community's history from another platform (#86).
 *
 * The importer (the `ofc community import discord` command) reads the
 * platform's export on the organiser's machine and sends already-mapped
 * batches of threads and posts. This module checks a batch and writes it.
 *
 * What is written, and by whom:
 *
 *  - Every record goes into the **community's** repository, signed with the
 *    community's key. Nobody on the source platform signed anything here, so
 *    nothing is written in their name: the records carry no `author`, and the
 *    original author appears only as a label in `importedFrom.author`. A
 *    private community's repository is readable only by its members, so its
 *    imported history is too; a public community's is public, like the rest of
 *    its repository.
 *  - Record keys are derived from the source ids (Discord snowflakes), so the
 *    same message always lands at the same address. Sending a batch again
 *    writes nothing new, which is what makes an import resumable.
 *
 * A snowflake is a 63-bit number; so is a TID (53 bits of microseconds and
 * 10 bits of clock id). The record key is the snowflake's bits written as a
 * TID. Both lexicons declare `"key": "tid"`, so a key such as `d<snowflake>`
 * would make every imported record invalid for any client that checks the
 * key type; this one is a well-formed TID, sorts in the same order as the
 * snowflakes (which are chronological), and decodes back to the snowflake.
 * Read as a time it falls years before the message, so it cannot meet a key
 * the PDS generates for a new record.
 */
import { TID } from '@atproto/common-web';
import { cidForRecord } from '@atproto/repo';
import { query } from '../db/client.js';
import { RepoEngine } from '../repo/repo-engine.js';
import { getKeypairForDid } from '../repo/keypair-utils.js';
import { FORUM_THREAD, FORUM_POST, indexThread, indexPost } from './forum-index.js';

export const IMPORT_PLATFORMS = ['discord'] as const;
export type ImportPlatform = typeof IMPORT_PLATFORMS[number];

/** Most threads, and most posts, one batch may carry. */
export const MAX_IMPORT_BATCH = 100;

export const MAX_TITLE_BYTES = 300;
export const MAX_TEXT_BYTES = 10000;
export const MAX_TAG_BYTES = 64;
export const MAX_TAGS = 20;
export const MAX_AUTHOR_BYTES = 100;
export const MAX_ATTACHMENTS = 100;

const SNOWFLAKE = /^[1-9][0-9]{0,19}$/;
const MAX_SNOWFLAKE = (1n << 63n) - 1n;
const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

export function isSnowflake(value: unknown): value is string {
  return typeof value === 'string' && SNOWFLAKE.test(value) && BigInt(value) <= MAX_SNOWFLAKE;
}

const S32 = '234567abcdefghijklmnopqrstuvwxyz';

/**
 * The record key for a source id: the snowflake's 63 bits written as a TID
 * (13 characters of base32-sortable, as `TID` writes its own value).
 */
export function snowflakeRkey(snowflake: string): string {
  if (!isSnowflake(snowflake)) throw new Error(`not a snowflake: ${snowflake}`);
  let value = BigInt(snowflake);
  let out = '';
  for (let i = 0; i < 13; i++) {
    out = S32[Number(value & 31n)] + out;
    value >>= 5n;
  }
  // Round-trips through the library's own parser: a well-formed TID.
  return new TID(out).toString();
}

/** The snowflake a record key was derived from (inverse of `snowflakeRkey`). */
export function snowflakeFromRkey(rkey: string): string {
  const tid = new TID(rkey);
  return ((BigInt(tid.timestamp()) << 10n) | BigInt(tid.clockid())).toString();
}

export interface ImportThreadInput {
  channelId: string;
  title: string;
  tags: string[];
  createdAt: string;
}

export interface ImportPostInput {
  channelId: string;
  messageId: string;
  replyToMessageId?: string;
  text: string;
  createdAt: string;
  editedAt?: string;
  author?: string;
  attachmentCount?: number;
}

export interface ImportBatch {
  community: string;
  platform: ImportPlatform;
  threads: ImportThreadInput[];
  posts: ImportPostInput[];
}

export type ImportCounts = { created: number; existing: number };

export class ImportBatchError extends Error {
  constructor(public readonly code: 'InvalidRequest' | 'ThreadNotFound' | 'ParentNotFound', message: string) {
    super(message);
  }
}

const bytes = (s: string) => Buffer.byteLength(s, 'utf8');

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function datetime(v: unknown, path: string): string {
  if (typeof v !== 'string' || !DATETIME.test(v) || Number.isNaN(Date.parse(v))) {
    throw new ImportBatchError('InvalidRequest', `${path} must be an RFC 3339 datetime`);
  }
  return new Date(v).toISOString();
}

function onlyKeys(v: Record<string, unknown>, allowed: string[], path: string): void {
  for (const key of Object.keys(v)) {
    if (!allowed.includes(key)) throw new ImportBatchError('InvalidRequest', `${path}.${key} is not allowed`);
  }
}

function snowflake(v: unknown, path: string): string {
  if (!isSnowflake(v)) throw new ImportBatchError('InvalidRequest', `${path} must be a source id (a Discord snowflake)`);
  return v;
}

function boundedString(v: unknown, path: string, maxBytes: number, opts: { allowEmpty?: boolean } = {}): string {
  if (typeof v !== 'string') throw new ImportBatchError('InvalidRequest', `${path} must be a string`);
  if (!opts.allowEmpty && !v.trim()) throw new ImportBatchError('InvalidRequest', `${path} must not be empty`);
  if (bytes(v) > maxBytes) throw new ImportBatchError('InvalidRequest', `${path} is longer than ${maxBytes} bytes`);
  return v;
}

/**
 * Check a batch strictly: the importer is a client like any other, and what
 * it sends ends up signed in the community's repository.
 */
export function parseImportBatch(body: unknown): ImportBatch {
  if (!isPlainObject(body)) throw new ImportBatchError('InvalidRequest', 'body must be an object');
  onlyKeys(body, ['community', 'platform', 'threads', 'posts'], '$');
  const { community, platform } = body;
  if (typeof community !== 'string' || !community.startsWith('did:')) {
    throw new ImportBatchError('InvalidRequest', 'community must be a DID');
  }
  if (!(IMPORT_PLATFORMS as readonly unknown[]).includes(platform)) {
    throw new ImportBatchError('InvalidRequest', `platform must be one of: ${IMPORT_PLATFORMS.join(', ')}`);
  }
  const rawThreads = body.threads ?? [];
  const rawPosts = body.posts ?? [];
  if (!Array.isArray(rawThreads) || !Array.isArray(rawPosts)) {
    throw new ImportBatchError('InvalidRequest', 'threads and posts must be arrays');
  }
  if (rawThreads.length > MAX_IMPORT_BATCH || rawPosts.length > MAX_IMPORT_BATCH) {
    throw new ImportBatchError('InvalidRequest', `at most ${MAX_IMPORT_BATCH} threads and ${MAX_IMPORT_BATCH} posts per batch`);
  }
  if (rawThreads.length === 0 && rawPosts.length === 0) {
    throw new ImportBatchError('InvalidRequest', 'the batch is empty');
  }

  const threadIds = new Set<string>();
  const threads = rawThreads.map((t, i): ImportThreadInput => {
    const path = `threads[${i}]`;
    if (!isPlainObject(t)) throw new ImportBatchError('InvalidRequest', `${path} must be an object`);
    onlyKeys(t, ['channelId', 'title', 'tags', 'createdAt'], path);
    const channelId = snowflake(t.channelId, `${path}.channelId`);
    if (threadIds.has(channelId)) throw new ImportBatchError('InvalidRequest', `${path}.channelId appears twice`);
    threadIds.add(channelId);
    const tags = t.tags ?? [];
    if (!Array.isArray(tags) || tags.length > MAX_TAGS) {
      throw new ImportBatchError('InvalidRequest', `${path}.tags must be a list of at most ${MAX_TAGS}`);
    }
    return {
      channelId,
      title: boundedString(t.title, `${path}.title`, MAX_TITLE_BYTES),
      tags: tags.map((tag, j) => boundedString(tag, `${path}.tags[${j}]`, MAX_TAG_BYTES)),
      createdAt: datetime(t.createdAt, `${path}.createdAt`),
    };
  });

  const postIds = new Set<string>();
  const posts = rawPosts.map((p, i): ImportPostInput => {
    const path = `posts[${i}]`;
    if (!isPlainObject(p)) throw new ImportBatchError('InvalidRequest', `${path} must be an object`);
    onlyKeys(p, ['channelId', 'messageId', 'replyToMessageId', 'text', 'createdAt', 'editedAt', 'author', 'attachmentCount'], path);
    const messageId = snowflake(p.messageId, `${path}.messageId`);
    if (postIds.has(messageId)) throw new ImportBatchError('InvalidRequest', `${path}.messageId appears twice`);
    postIds.add(messageId);
    const post: ImportPostInput = {
      channelId: snowflake(p.channelId, `${path}.channelId`),
      messageId,
      text: boundedString(p.text, `${path}.text`, MAX_TEXT_BYTES, { allowEmpty: true }),
      createdAt: datetime(p.createdAt, `${path}.createdAt`),
    };
    if (p.replyToMessageId !== undefined) {
      post.replyToMessageId = snowflake(p.replyToMessageId, `${path}.replyToMessageId`);
      if (post.replyToMessageId === messageId) throw new ImportBatchError('InvalidRequest', `${path} replies to itself`);
    }
    if (p.editedAt !== undefined) post.editedAt = datetime(p.editedAt, `${path}.editedAt`);
    if (p.author !== undefined) post.author = boundedString(p.author, `${path}.author`, MAX_AUTHOR_BYTES);
    if (p.attachmentCount !== undefined) {
      const n = p.attachmentCount;
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > MAX_ATTACHMENTS) {
        throw new ImportBatchError('InvalidRequest', `${path}.attachmentCount must be an integer from 0 to ${MAX_ATTACHMENTS}`);
      }
      post.attachmentCount = n;
    }
    if (!post.text.trim() && !post.attachmentCount) {
      throw new ImportBatchError('InvalidRequest', `${path} has neither text nor attachments`);
    }
    return post;
  });

  return { community, platform: platform as ImportPlatform, threads, posts };
}

type Stored = { uri: string; cid: string; record: Record<string, unknown> };

function importedChannel(record: Record<string, unknown>): string | null {
  const from = record.importedFrom;
  return isPlainObject(from) && typeof from.channelId === 'string' ? from.channelId : null;
}

/**
 * Write a checked batch into the community's repository, in one commit, and
 * index it. Records already there are left untouched and counted as
 * `existing`; they are indexed again, so a run interrupted between the commit
 * and the index is repaired by sending the batch again.
 */
export async function importForumBatch(batch: ImportBatch): Promise<{ threads: ImportCounts; posts: ImportCounts }> {
  const did = batch.community;
  const uriOf = (collection: string, rkey: string) => `at://${did}/${collection}/${rkey}`;

  // Everything the batch could refer to: its own threads and posts, the
  // threads its posts belong to, and the posts they reply to.
  const threadKeys = new Set<string>([
    ...batch.threads.map((t) => snowflakeRkey(t.channelId)),
    ...batch.posts.map((p) => snowflakeRkey(p.channelId)),
  ]);
  const postKeys = new Set<string>([
    ...batch.posts.map((p) => snowflakeRkey(p.messageId)),
    ...batch.posts.filter((p) => p.replyToMessageId).map((p) => snowflakeRkey(p.replyToMessageId!)),
  ]);
  const found = await query<{ collection: string; rkey: string; cid: string; record: Record<string, unknown> }>(
    `SELECT collection, rkey, cid, record FROM records_index
     WHERE community_did = $1
       AND ((collection = $2 AND rkey = ANY($3)) OR (collection = $4 AND rkey = ANY($5)))`,
    [did, FORUM_THREAD, [...threadKeys], FORUM_POST, [...postKeys]],
  );
  const threadsByChannel = new Map<string, Stored>();
  const postsByMessage = new Map<string, Stored>();
  for (const row of found.rows) {
    const stored = { uri: uriOf(row.collection, row.rkey), cid: row.cid, record: row.record };
    if (row.collection === FORUM_THREAD) threadsByChannel.set(snowflakeFromRkey(row.rkey), stored);
    else postsByMessage.set(snowflakeFromRkey(row.rkey), stored);
  }

  const writes: Array<{ action: 'write'; collection: string; rkey: string; record: Record<string, unknown> }> = [];
  const counts = { threads: { created: 0, existing: 0 }, posts: { created: 0, existing: 0 } };
  const toIndexThreads: Stored[] = [];
  const toIndexPosts: Stored[] = [];

  for (const t of batch.threads) {
    const existing = threadsByChannel.get(t.channelId);
    if (existing) {
      if (importedChannel(existing.record) !== t.channelId) {
        throw new ImportBatchError('InvalidRequest', `a thread not imported from channel ${t.channelId} holds its record key`);
      }
      counts.threads.existing++;
      toIndexThreads.push(existing);
      continue;
    }
    const rkey = snowflakeRkey(t.channelId);
    const record: Record<string, unknown> = {
      $type: FORUM_THREAD,
      community: did,
      title: t.title,
      tags: t.tags,
      createdAt: t.createdAt,
      importedFrom: { platform: batch.platform, channelId: t.channelId },
    };
    const stored = { uri: uriOf(FORUM_THREAD, rkey), cid: (await cidForRecord(record)).toString(), record };
    threadsByChannel.set(t.channelId, stored);
    writes.push({ action: 'write', collection: FORUM_THREAD, rkey, record });
    toIndexThreads.push(stored);
    counts.threads.created++;
  }

  for (const [i, p] of batch.posts.entries()) {
    const existing = postsByMessage.get(p.messageId);
    if (existing) {
      counts.posts.existing++;
      toIndexPosts.push(existing);
      continue;
    }
    const thread = threadsByChannel.get(p.channelId);
    if (!thread || importedChannel(thread.record) !== p.channelId) {
      throw new ImportBatchError('ThreadNotFound', `posts[${i}]: channel ${p.channelId} has not been imported as a thread`);
    }
    let parent: { uri: string; cid: string } | undefined;
    if (p.replyToMessageId) {
      const replied = postsByMessage.get(p.replyToMessageId);
      if (!replied || importedChannel(replied.record) !== p.channelId) {
        throw new ImportBatchError('ParentNotFound', `posts[${i}]: message ${p.replyToMessageId} has not been imported in the same channel`);
      }
      parent = { uri: replied.uri, cid: replied.cid };
    }
    const rkey = snowflakeRkey(p.messageId);
    const importedFrom: Record<string, unknown> = {
      platform: batch.platform, channelId: p.channelId, messageId: p.messageId,
      ...(p.author !== undefined ? { author: p.author } : {}),
      ...(p.editedAt !== undefined ? { editedAt: p.editedAt } : {}),
      ...(p.attachmentCount ? { attachmentCount: p.attachmentCount } : {}),
    };
    const record: Record<string, unknown> = {
      $type: FORUM_POST,
      community: did,
      root: { uri: thread.uri, cid: thread.cid },
      ...(parent ? { parent } : {}),
      text: p.text,
      createdAt: p.createdAt,
      importedFrom,
    };
    const stored = { uri: uriOf(FORUM_POST, rkey), cid: (await cidForRecord(record)).toString(), record };
    postsByMessage.set(p.messageId, stored);
    writes.push({ action: 'write', collection: FORUM_POST, rkey, record });
    toIndexPosts.push(stored);
    counts.posts.created++;
  }

  if (writes.length > 0) {
    await new RepoEngine(did).applyWrites(await getKeypairForDid(did), writes);
  }

  for (const t of toIndexThreads) {
    const r = t.record as { title: string; tags?: string[]; createdAt: string };
    await indexThread({
      uri: t.uri, cid: t.cid, communityDid: did, authorDid: did,
      title: r.title, tags: r.tags ?? [], createdAt: r.createdAt,
    });
  }
  for (const p of toIndexPosts) {
    const r = p.record as { root: { uri: string }; parent?: { uri: string }; createdAt: string };
    await indexPost({
      uri: p.uri, cid: p.cid, communityDid: did, authorDid: did,
      threadRootUri: r.root.uri, parentUri: r.parent?.uri ?? null,
      record: p.record, createdAt: r.createdAt,
    });
  }

  return counts;
}
