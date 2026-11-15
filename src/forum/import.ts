/**
 * Importing a community's history from another platform (#86, #403).
 *
 * The importer (the `ofc community import discord|slack` command) reads the
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
 *  - Record keys are derived from the source ids (Discord snowflakes, Slack
 *    channel ids and message timestamps), so the same message always lands at
 *    the same address. Sending a batch again writes nothing new, which is what
 *    makes an import resumable.
 *  - An imported record that is deleted afterwards leaves a tombstone: its
 *    record key (`forum_import_tombstones`). A later batch skips it, so a
 *    re-run, even one without the importer's checkpoint, does not bring it
 *    back (#403).
 *  - Attachments arrive as blobs uploaded beforehand for the community
 *    (`net.openfederation.forum.importBlob`) and are linked as `embeds`.
 *
 * A snowflake is a 63-bit number; so is a TID (53 bits of microseconds and
 * 10 bits of clock id). The record key is the snowflake's bits written as a
 * TID. Both lexicons declare `"key": "tid"`, so a key such as `d<snowflake>`
 * would make every imported record invalid for any client that checks the
 * key type; this one is a well-formed TID, sorts in the same order as the
 * snowflakes (which are chronological), and decodes back to the snowflake.
 * Read as a time it falls years before the message, so it cannot meet a key
 * the PDS generates for a new record.
 *
 * Slack has no snowflakes (#403). A message is named by its channel and its
 * `ts` ("1700000000.123456", unique within the channel, microseconds), a
 * channel by an id such as `C0123ABCD`. The key is built the same shape as a
 * snowflake: milliseconds since 2013-01-01 in the top bits, then the
 * microseconds, then 12 bits of a hash of the channel id, so messages from
 * two channels at the same microsecond still differ. A channel's key is 40
 * bits of a hash of its id, below any message key. Both are well-formed TIDs
 * that read as times long past.
 */
import { createHash } from 'node:crypto';
import { TID } from '@atproto/common-web';
import { cidForRecord } from '@atproto/repo';
import { CID } from 'multiformats/cid';
import { config } from '../config.js';
import { query } from '../db/client.js';
import { RepoEngine } from '../repo/repo-engine.js';
import { getKeypairForDid } from '../repo/keypair-utils.js';
import { FORUM_THREAD, FORUM_POST, indexThread, indexPost } from './forum-index.js';

export const IMPORT_PLATFORMS = ['discord', 'slack'] as const;
export type ImportPlatform = typeof IMPORT_PLATFORMS[number];

/** Most threads, and most posts, one batch may carry. */
export const MAX_IMPORT_BATCH = 100;

export const MAX_TITLE_BYTES = 300;
export const MAX_TEXT_BYTES = 10000;
export const MAX_TAG_BYTES = 64;
export const MAX_TAGS = 20;
export const MAX_AUTHOR_BYTES = 100;
export const MAX_ATTACHMENTS = 100;
/** `embeds` of net.openfederation.forum.post: at most 4 images of at most 1,000,000 bytes. */
export const MAX_EMBEDS = 4;
export const MAX_EMBED_BYTES = 1_000_000;

const SNOWFLAKE = /^[1-9][0-9]{0,19}$/;
const MAX_SNOWFLAKE = (1n << 63n) - 1n;
const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

export function isSnowflake(value: unknown): value is string {
  return typeof value === 'string' && SNOWFLAKE.test(value) && BigInt(value) <= MAX_SNOWFLAKE;
}

const SLACK_CHANNEL = /^[CG][A-Z0-9]{2,30}$/;
const SLACK_TS = /^[0-9]{9,10}\.[0-9]{6}$/;
/** 2013-01-01T00:00:00Z, before Slack's launch. */
export const SLACK_EPOCH_MS = 1356998400000n;

/** A Slack public (C…) or private (G…) channel id. Direct messages (D…) are never imported. */
export function isSlackChannelId(value: unknown): value is string {
  return typeof value === 'string' && SLACK_CHANNEL.test(value);
}

/** A Slack message timestamp: seconds, a dot, six digits. */
export function isSlackTs(value: unknown): value is string {
  return typeof value === 'string' && SLACK_TS.test(value);
}

const S32 = '234567abcdefghijklmnopqrstuvwxyz';

/** A 63-bit value written as a TID (13 characters of base32-sortable, as `TID` writes its own value). */
function valueRkey(v: bigint): string {
  if (v < 0n || v > MAX_SNOWFLAKE) throw new Error('record key value out of range');
  let value = v;
  let out = '';
  for (let i = 0; i < 13; i++) {
    out = S32[Number(value & 31n)] + out;
    value >>= 5n;
  }
  // Round-trips through the library's own parser: a well-formed TID.
  return new TID(out).toString();
}

/** The record key for a source id: the snowflake's 63 bits written as a TID. */
export function snowflakeRkey(snowflake: string): string {
  if (!isSnowflake(snowflake)) throw new Error(`not a snowflake: ${snowflake}`);
  return valueRkey(BigInt(snowflake));
}

/** The snowflake a record key was derived from (inverse of `snowflakeRkey`). */
export function snowflakeFromRkey(rkey: string): string {
  const tid = new TID(rkey);
  return ((BigInt(tid.timestamp()) << 10n) | BigInt(tid.clockid())).toString();
}

function channelHash(channelId: string): Buffer {
  return createHash('sha256').update(`slack-channel:${channelId}`).digest();
}

/** A Slack `ts` in microseconds since 1970. */
export function slackTsMicros(ts: string): bigint {
  if (!isSlackTs(ts)) throw new Error(`not a Slack timestamp: ${ts}`);
  const [sec, frac] = ts.split('.');
  return BigInt(sec) * 1_000_000n + BigInt(frac);
}

/** The value behind a Slack message's record key, or null when the time is out of range. */
function slackMessageValue(channelId: string, ts: string): bigint | null {
  const us = slackTsMicros(ts);
  const sinceEpoch = us / 1000n - SLACK_EPOCH_MS;
  // Below 2^18 ms the key would fall among channel keys (< 2^40).
  if (sinceEpoch < 1n << 18n) return null;
  const h = channelHash(channelId);
  const value = (sinceEpoch << 22n) | ((us % 1000n) << 12n) | BigInt(((h[5] << 8) | h[6]) & 0xfff);
  return value > MAX_SNOWFLAKE ? null : value;
}

/** Whether a Slack message's time can be given a record key (2013 to the 2150s). */
export function slackTsInRange(channelId: string, ts: string): boolean {
  return isSlackTs(ts) && slackMessageValue(channelId, ts) !== null;
}

/** The record key of the forum thread made from a source channel or thread. */
export function threadRkey(platform: ImportPlatform, channelId: string): string {
  if (platform === 'slack') {
    if (!isSlackChannelId(channelId)) throw new Error(`not a Slack channel id: ${channelId}`);
    return valueRkey(channelHash(channelId).readBigUInt64BE(0) >> 24n);
  }
  return snowflakeRkey(channelId);
}

/** The record key of the forum post made from a source message. */
export function postRkey(platform: ImportPlatform, channelId: string, messageId: string): string {
  if (platform === 'slack') {
    const value = slackMessageValue(channelId, messageId);
    if (value === null) throw new Error(`Slack timestamp out of range: ${messageId}`);
    return valueRkey(value);
  }
  return snowflakeRkey(messageId);
}

export interface ImportThreadInput {
  channelId: string;
  title: string;
  tags: string[];
  createdAt: string;
}

/** A blob ref as `net.openfederation.forum.importBlob` returned it. */
export interface ImportBlobRef { $type: 'blob'; ref: { $link: string }; mimeType: string; size: number }

export interface ImportPostInput {
  channelId: string;
  messageId: string;
  replyToMessageId?: string;
  text: string;
  createdAt: string;
  editedAt?: string;
  author?: string;
  attachmentCount?: number;
  embeds?: ImportBlobRef[];
}

export interface ImportBatch {
  community: string;
  platform: ImportPlatform;
  threads: ImportThreadInput[];
  posts: ImportPostInput[];
}

export type ImportCounts = { created: number; existing: number; deleted: number };

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

function channelId(platform: ImportPlatform, v: unknown, path: string): string {
  if (platform === 'slack') {
    if (!isSlackChannelId(v)) throw new ImportBatchError('InvalidRequest', `${path} must be a Slack channel id (C… or G…)`);
    return v;
  }
  if (!isSnowflake(v)) throw new ImportBatchError('InvalidRequest', `${path} must be a source id (a Discord snowflake)`);
  return v;
}

function messageId(platform: ImportPlatform, channel: string, v: unknown, path: string): string {
  if (platform === 'slack') {
    if (!isSlackTs(v)) throw new ImportBatchError('InvalidRequest', `${path} must be a Slack message timestamp`);
    if (!slackTsInRange(channel, v)) throw new ImportBatchError('InvalidRequest', `${path} is outside the importable time range`);
    return v;
  }
  if (!isSnowflake(v)) throw new ImportBatchError('InvalidRequest', `${path} must be a source id (a Discord snowflake)`);
  return v;
}

/** Largest blob a post may link: the server's blob limit, and the forum.post lexicon's. */
export function maxEmbedBytes(): number {
  return Math.min(config.blob.maxSize, MAX_EMBED_BYTES);
}

function blobRef(v: unknown, path: string): ImportBlobRef {
  if (!isPlainObject(v)) throw new ImportBatchError('InvalidRequest', `${path} must be a blob ref`);
  onlyKeys(v, ['$type', 'ref', 'mimeType', 'size'], path);
  const ref = v.ref;
  if (v.$type !== 'blob' || !isPlainObject(ref) || typeof ref.$link !== 'string' || Object.keys(ref).length !== 1) {
    throw new ImportBatchError('InvalidRequest', `${path} must be the blob object net.openfederation.forum.importBlob returned`);
  }
  let canonical = false;
  try { canonical = CID.parse(ref.$link).toString() === ref.$link; } catch { canonical = false; }
  if (!canonical) throw new ImportBatchError('InvalidRequest', `${path}.ref is not a CID`);
  if (typeof v.mimeType !== 'string' || !config.blob.allowedMimeTypes.includes(v.mimeType)) {
    throw new ImportBatchError('InvalidRequest', `${path}.mimeType must be one of: ${config.blob.allowedMimeTypes.join(', ')}`);
  }
  const size = v.size;
  if (typeof size !== 'number' || !Number.isInteger(size) || size < 1 || size > maxEmbedBytes()) {
    throw new ImportBatchError('InvalidRequest', `${path}.size must be from 1 to ${maxEmbedBytes()} bytes`);
  }
  return { $type: 'blob', ref: { $link: ref.$link }, mimeType: v.mimeType, size };
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
  const plat = platform as ImportPlatform;
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
    const channel = channelId(plat, t.channelId, `${path}.channelId`);
    if (threadIds.has(channel)) throw new ImportBatchError('InvalidRequest', `${path}.channelId appears twice`);
    threadIds.add(channel);
    const tags = t.tags ?? [];
    if (!Array.isArray(tags) || tags.length > MAX_TAGS) {
      throw new ImportBatchError('InvalidRequest', `${path}.tags must be a list of at most ${MAX_TAGS}`);
    }
    return {
      channelId: channel,
      title: boundedString(t.title, `${path}.title`, MAX_TITLE_BYTES),
      tags: tags.map((tag, j) => boundedString(tag, `${path}.tags[${j}]`, MAX_TAG_BYTES)),
      createdAt: datetime(t.createdAt, `${path}.createdAt`),
    };
  });

  const postIds = new Set<string>();
  const posts = rawPosts.map((p, i): ImportPostInput => {
    const path = `posts[${i}]`;
    if (!isPlainObject(p)) throw new ImportBatchError('InvalidRequest', `${path} must be an object`);
    onlyKeys(p, ['channelId', 'messageId', 'replyToMessageId', 'text', 'createdAt', 'editedAt', 'author', 'attachmentCount', 'embeds'], path);
    const channel = channelId(plat, p.channelId, `${path}.channelId`);
    const message = messageId(plat, channel, p.messageId, `${path}.messageId`);
    // Slack timestamps are unique only within a channel.
    const unique = `${channel}/${message}`;
    if (postIds.has(unique)) throw new ImportBatchError('InvalidRequest', `${path}.messageId appears twice`);
    postIds.add(unique);
    const post: ImportPostInput = {
      channelId: channel,
      messageId: message,
      text: boundedString(p.text, `${path}.text`, MAX_TEXT_BYTES, { allowEmpty: true }),
      createdAt: datetime(p.createdAt, `${path}.createdAt`),
    };
    if (p.replyToMessageId !== undefined) {
      post.replyToMessageId = messageId(plat, channel, p.replyToMessageId, `${path}.replyToMessageId`);
      if (post.replyToMessageId === message) throw new ImportBatchError('InvalidRequest', `${path} replies to itself`);
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
    if (p.embeds !== undefined) {
      if (!Array.isArray(p.embeds) || p.embeds.length > MAX_EMBEDS) {
        throw new ImportBatchError('InvalidRequest', `${path}.embeds must be a list of at most ${MAX_EMBEDS} blobs`);
      }
      const embeds = p.embeds.map((e, j) => blobRef(e, `${path}.embeds[${j}]`));
      if (embeds.length > (post.attachmentCount ?? 0)) {
        throw new ImportBatchError('InvalidRequest', `${path}.embeds has more blobs than attachmentCount`);
      }
      if (embeds.length > 0) post.embeds = embeds;
    }
    if (!post.text.trim() && !post.attachmentCount) {
      throw new ImportBatchError('InvalidRequest', `${path} has neither text nor attachments`);
    }
    return post;
  });

  return { community, platform: plat, threads, posts };
}

type Stored = { uri: string; cid: string; record: Record<string, unknown> };

function importedFrom(record: Record<string, unknown>): Record<string, unknown> | null {
  return isPlainObject(record.importedFrom) ? record.importedFrom : null;
}

function importedChannel(record: Record<string, unknown>, platform: ImportPlatform): string | null {
  const from = importedFrom(record);
  return from && from.platform === platform && typeof from.channelId === 'string' ? from.channelId : null;
}

function isImportOf(record: Record<string, unknown>, platform: ImportPlatform, channel: string, message: string): boolean {
  const from = importedFrom(record);
  return !!from && from.platform === platform && from.channelId === channel && from.messageId === message;
}

/** Whether a record was written by an import (it carries `importedFrom`). */
export function isImportedRecord(record: Record<string, unknown>): boolean {
  const from = importedFrom(record);
  return !!from && typeof from.platform === 'string';
}

/**
 * Remember that an imported record was deleted, so importBatch does not write
 * it again. Only records that carry `importedFrom` leave a tombstone; nothing
 * of the record's content is kept, only its address.
 */
export async function recordImportTombstone(uri: string, record: Record<string, unknown>): Promise<boolean> {
  const from = importedFrom(record);
  if (!from || typeof from.platform !== 'string') return false;
  const [, , repo, collection, rkey] = uri.split('/');
  await query(
    `INSERT INTO forum_import_tombstones (community_did, collection, rkey, platform)
     VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
    [repo, collection, rkey, from.platform],
  );
  return true;
}

/**
 * Write a checked batch into the community's repository, in one commit, and
 * index it. Records already there are left untouched and counted as
 * `existing`; they are indexed again, so a run interrupted between the commit
 * and the index is repaired by sending the batch again. Records deleted after
 * an earlier import are skipped and counted as `deleted`.
 */
export async function importForumBatch(batch: ImportBatch): Promise<{ threads: ImportCounts; posts: ImportCounts }> {
  const did = batch.community;
  const platform = batch.platform;
  const uriOf = (collection: string, rkey: string) => `at://${did}/${collection}/${rkey}`;
  const threadKey = (channel: string) => threadRkey(platform, channel);
  const postKey = (channel: string, message: string) => postRkey(platform, channel, message);

  // Everything the batch could refer to: its own threads and posts, the
  // threads its posts belong to, and the posts they reply to.
  const threadKeys = [...new Set<string>([
    ...batch.threads.map((t) => threadKey(t.channelId)),
    ...batch.posts.map((p) => threadKey(p.channelId)),
  ])];
  const postKeys = [...new Set<string>([
    ...batch.posts.map((p) => postKey(p.channelId, p.messageId)),
    ...batch.posts.filter((p) => p.replyToMessageId).map((p) => postKey(p.channelId, p.replyToMessageId!)),
  ])];
  const found = await query<{ collection: string; rkey: string; cid: string; record: Record<string, unknown> }>(
    `SELECT collection, rkey, cid, record FROM records_index
     WHERE community_did = $1
       AND ((collection = $2 AND rkey = ANY($3)) OR (collection = $4 AND rkey = ANY($5)))`,
    [did, FORUM_THREAD, threadKeys, FORUM_POST, postKeys],
  );
  const threadsByKey = new Map<string, Stored>();
  const postsByKey = new Map<string, Stored>();
  for (const row of found.rows) {
    const stored = { uri: uriOf(row.collection, row.rkey), cid: row.cid, record: row.record };
    if (row.collection === FORUM_THREAD) threadsByKey.set(row.rkey, stored);
    else postsByKey.set(row.rkey, stored);
  }
  const tombstones = await query<{ collection: string; rkey: string }>(
    `SELECT collection, rkey FROM forum_import_tombstones
     WHERE community_did = $1
       AND ((collection = $2 AND rkey = ANY($3)) OR (collection = $4 AND rkey = ANY($5)))`,
    [did, FORUM_THREAD, threadKeys, FORUM_POST, postKeys],
  );
  const deletedThreads = new Set(tombstones.rows.filter((r) => r.collection === FORUM_THREAD).map((r) => r.rkey));
  const deletedPosts = new Set(tombstones.rows.filter((r) => r.collection === FORUM_POST).map((r) => r.rkey));

  // Blobs a post links must have been uploaded for this community.
  const links = [...new Set(batch.posts.flatMap((p) => (p.embeds ?? []).map((e) => e.ref.$link)))];
  const blobs = new Map<string, { mime_type: string; size: number }>();
  if (links.length > 0) {
    const rows = await query<{ cid: string; mime_type: string; size: number }>(
      `SELECT b.cid, b.mime_type, b.size FROM blobs b
       JOIN blob_owners o ON o.cid = b.cid AND o.did = $1
       WHERE b.cid = ANY($2)`,
      [did, links],
    );
    for (const r of rows.rows) blobs.set(r.cid, r);
  }

  const writes: Array<{ action: 'write'; collection: string; rkey: string; record: Record<string, unknown> }> = [];
  const counts = { threads: { created: 0, existing: 0, deleted: 0 }, posts: { created: 0, existing: 0, deleted: 0 } };
  const toIndexThreads: Stored[] = [];
  const toIndexPosts: Stored[] = [];

  for (const t of batch.threads) {
    const rkey = threadKey(t.channelId);
    const existing = threadsByKey.get(rkey);
    if (existing) {
      if (importedChannel(existing.record, platform) !== t.channelId) {
        throw new ImportBatchError('InvalidRequest', `a thread not imported from channel ${t.channelId} holds its record key`);
      }
      counts.threads.existing++;
      toIndexThreads.push(existing);
      continue;
    }
    if (deletedThreads.has(rkey)) {
      counts.threads.deleted++;
      continue;
    }
    const record: Record<string, unknown> = {
      $type: FORUM_THREAD,
      community: did,
      title: t.title,
      tags: t.tags,
      createdAt: t.createdAt,
      importedFrom: { platform, channelId: t.channelId },
    };
    const stored = { uri: uriOf(FORUM_THREAD, rkey), cid: (await cidForRecord(record)).toString(), record };
    threadsByKey.set(rkey, stored);
    writes.push({ action: 'write', collection: FORUM_THREAD, rkey, record });
    toIndexThreads.push(stored);
    counts.threads.created++;
  }

  for (const [i, p] of batch.posts.entries()) {
    const rkey = postKey(p.channelId, p.messageId);
    const existing = postsByKey.get(rkey);
    if (existing) {
      if (!isImportOf(existing.record, platform, p.channelId, p.messageId)) {
        throw new ImportBatchError('InvalidRequest', `posts[${i}]: a post not imported from message ${p.messageId} holds its record key`);
      }
      counts.posts.existing++;
      toIndexPosts.push(existing);
      continue;
    }
    // Deleted after an earlier import, or in a deleted thread: stays deleted.
    if (deletedPosts.has(rkey) || deletedThreads.has(threadKey(p.channelId))) {
      counts.posts.deleted++;
      continue;
    }
    const thread = threadsByKey.get(threadKey(p.channelId));
    if (!thread || importedChannel(thread.record, platform) !== p.channelId) {
      throw new ImportBatchError('ThreadNotFound', `posts[${i}]: channel ${p.channelId} has not been imported as a thread`);
    }
    let parent: { uri: string; cid: string } | undefined;
    if (p.replyToMessageId) {
      const parentKey = postKey(p.channelId, p.replyToMessageId);
      const replied = postsByKey.get(parentKey);
      if (replied && isImportOf(replied.record, platform, p.channelId, p.replyToMessageId)) {
        parent = { uri: replied.uri, cid: replied.cid };
      } else if (replied || !deletedPosts.has(parentKey)) {
        throw new ImportBatchError('ParentNotFound', `posts[${i}]: message ${p.replyToMessageId} has not been imported in the same channel`);
      }
      // Otherwise it answered a post that was deleted: kept, without the link.
    }
    for (const [j, e] of (p.embeds ?? []).entries()) {
      const blob = blobs.get(e.ref.$link);
      if (!blob || blob.mime_type !== e.mimeType || Number(blob.size) !== e.size) {
        throw new ImportBatchError('InvalidRequest', `posts[${i}].embeds[${j}]: no such blob uploaded for this community`);
      }
    }
    const importedFrom: Record<string, unknown> = {
      platform, channelId: p.channelId, messageId: p.messageId,
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
      ...(p.embeds && p.embeds.length > 0 ? { embeds: p.embeds } : {}),
      createdAt: p.createdAt,
      importedFrom,
    };
    const stored = { uri: uriOf(FORUM_POST, rkey), cid: (await cidForRecord(record)).toString(), record };
    postsByKey.set(rkey, stored);
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
