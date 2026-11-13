/**
 * Reading a Discord export and mapping it to forum threads and posts (#86).
 *
 * Input: the JSON files DiscordChatExporter writes, one per channel or
 * thread. They are treated as untrusted: sizes are capped, every field the
 * importer uses is checked, and a file that does not look like an export is
 * refused with the reason. No Discord token is involved anywhere.
 *
 * Mapping (see `mapExport`):
 *  - each channel becomes a forum thread titled `#name`, tagged `discord` and
 *    its category; each Discord thread becomes a forum thread titled after it,
 *    tagged `discord` and `#parent-channel`. (The forum has no boards or
 *    categories, only threads with tags.)
 *  - each message becomes a post, in order, keeping its original time; a reply
 *    keeps its link when the message it answers was imported in the same
 *    channel.
 *  - bots' messages are skipped unless asked for; system messages (joins,
 *    pins, "thread created", calls…) always are; private threads are skipped
 *    unless asked for; direct-message exports are refused.
 *  - authors are shown as "Discord member 1", "Discord member 2"… numbered in
 *    order of first appearance, unless names are explicitly kept. Discord user
 *    ids never go into what is sent to the PDS. Mentions inside the text are
 *    rewritten the same way.
 *  - attachments are counted, never uploaded or linked (Discord CDN links
 *    expire and carry signed tokens).
 *
 * Pure apart from `readExportDir` / `readMembersCsv`, which only read files.
 */
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const LIMITS = {
  /** Largest export file read. DiscordChatExporter splits nothing by default, so busy channels are big. */
  maxFileBytes: 128 * 1024 * 1024,
  maxFiles: 5000,
  maxMessagesPerFile: 1_000_000,
  /** Discord allows 4000 characters; anything far beyond is not a real export. */
  maxContentChars: 10_000,
  maxNameChars: 200,
  maxTopicChars: 4096,
  maxAttachments: 100,
  maxMentions: 500,
  maxMembersCsvBytes: 16 * 1024 * 1024,
  maxMembers: 200_000,
} as const;

/** Mirrors the PDS limits in src/forum/import.ts (UTF-8 bytes). */
export const RECORD_LIMITS = { titleBytes: 300, textBytes: 10_000, tagBytes: 64, authorBytes: 100 } as const;

const THREAD_TYPES = new Set(['GuildPublicThread', 'GuildPrivateThread', 'GuildNewsThread']);
const DIRECT_TYPES = new Set(['DirectTextChat', 'DirectGroupTextChat']);
/** Message kinds that are someone writing something; everything else is a system notice. */
const CONTENT_KINDS = new Set(['Default', 'Reply']);
const SNOWFLAKE = /^[1-9][0-9]{0,19}$/;
const MAX_SNOWFLAKE = (1n << 63n) - 1n;

export class DiscordExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DiscordExportError';
  }
}

export interface ExportAuthor { id: string; name: string; nickname: string | null; isBot: boolean }
export interface ExportMention { id: string; name: string; nickname: string | null }
export interface ExportMessage {
  id: string;
  type: string;
  timestamp: string;
  editedAt: string | null;
  content: string;
  author: ExportAuthor;
  attachmentCount: number;
  replyTo: string | null;
  mentions: ExportMention[];
}
export interface ExportChannel {
  file: string;
  guildId: string;
  guildName: string;
  id: string;
  type: string;
  name: string;
  /** For a channel: its category. For a thread: its parent channel (that is how the exporter writes it). */
  categoryId: string | null;
  category: string | null;
  isThread: boolean;
  messages: ExportMessage[];
}

// ── Validation helpers ─────────────────────────────────────────────

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function isSnowflake(v: unknown): v is string {
  return typeof v === 'string' && SNOWFLAKE.test(v) && BigInt(v) <= MAX_SNOWFLAKE;
}

function fail(file: string, path: string, why: string): never {
  throw new DiscordExportError(`${file}: ${path} ${why}`);
}

function snowflake(file: string, path: string, v: unknown): string {
  // The exporter writes ids as strings; accept a safe integer too.
  const s = typeof v === 'number' && Number.isSafeInteger(v) ? String(v) : v;
  if (!isSnowflake(s)) fail(file, path, 'is not a Discord id');
  return s;
}

function str(file: string, path: string, v: unknown, max: number, opts: { optional?: boolean } = {}): string | null {
  if (v === undefined || v === null) {
    if (opts.optional) return null;
    fail(file, path, 'is missing');
  }
  if (typeof v !== 'string') fail(file, path, 'is not a string');
  if (v.length > max) fail(file, path, `is longer than ${max} characters`);
  return v;
}

function time(file: string, path: string, v: unknown, opts: { optional?: boolean } = {}): string | null {
  if ((v === undefined || v === null) && opts.optional) return null;
  if (typeof v !== 'string' || v.length > 64 || Number.isNaN(Date.parse(v)) || !/^\d{4}-\d{2}-\d{2}T/.test(v)) {
    fail(file, path, 'is not a timestamp');
  }
  return new Date(v).toISOString();
}

function compareIds(a: string, b: string): number {
  const x = BigInt(a), y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

// ── Parsing ─────────────────────────────────────────────────────────

/** Check one export file's JSON and keep only what the importer uses. */
export function parseExportJson(text: string, file: string): ExportChannel {
  if (text.length > LIMITS.maxFileBytes) fail(file, 'file', 'is too large');
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new DiscordExportError(`${file}: not valid JSON`);
  }
  if (!isObject(doc)) fail(file, '$', 'is not an object');
  const guild = doc.guild;
  const channel = doc.channel;
  if (!isObject(guild)) fail(file, 'guild', 'is missing (is this a DiscordChatExporter JSON export?)');
  if (!isObject(channel)) fail(file, 'channel', 'is missing (is this a DiscordChatExporter JSON export?)');
  if (!Array.isArray(doc.messages)) fail(file, 'messages', 'is not a list');
  if (doc.messages.length > LIMITS.maxMessagesPerFile) fail(file, 'messages', 'has too many entries');

  const type = str(file, 'channel.type', channel.type, 64)!;
  if (DIRECT_TYPES.has(type)) {
    throw new DiscordExportError(`${file}: is a direct-message export; private conversations are never imported`);
  }

  const messages = doc.messages.map((m: unknown, i: number): ExportMessage => {
    const p = `messages[${i}]`;
    if (!isObject(m)) fail(file, p, 'is not an object');
    const author = m.author;
    if (!isObject(author)) fail(file, `${p}.author`, 'is missing');
    if (typeof author.isBot !== 'boolean' && author.isBot !== undefined) fail(file, `${p}.author.isBot`, 'is not true/false');
    const attachments = m.attachments ?? [];
    if (!Array.isArray(attachments) || attachments.length > LIMITS.maxAttachments) fail(file, `${p}.attachments`, 'is not a short list');
    const reference = m.reference;
    let replyTo: string | null = null;
    if (reference !== undefined && reference !== null) {
      if (!isObject(reference)) fail(file, `${p}.reference`, 'is not an object');
      if (reference.messageId !== undefined && reference.messageId !== null) {
        replyTo = snowflake(file, `${p}.reference.messageId`, reference.messageId);
      }
    }
    const rawMentions = m.mentions ?? [];
    if (!Array.isArray(rawMentions) || rawMentions.length > LIMITS.maxMentions) fail(file, `${p}.mentions`, 'is not a short list');
    const mentions = rawMentions.map((u: unknown, j: number): ExportMention => {
      const mp = `${p}.mentions[${j}]`;
      if (!isObject(u)) fail(file, mp, 'is not an object');
      return {
        id: snowflake(file, `${mp}.id`, u.id),
        name: str(file, `${mp}.name`, u.name, LIMITS.maxNameChars)!,
        nickname: str(file, `${mp}.nickname`, u.nickname, LIMITS.maxNameChars, { optional: true }),
      };
    });
    return {
      id: snowflake(file, `${p}.id`, m.id),
      type: str(file, `${p}.type`, m.type, 64)!,
      timestamp: time(file, `${p}.timestamp`, m.timestamp)!,
      editedAt: time(file, `${p}.timestampEdited`, m.timestampEdited, { optional: true }),
      content: str(file, `${p}.content`, m.content ?? '', LIMITS.maxContentChars)!,
      author: {
        id: snowflake(file, `${p}.author.id`, author.id),
        name: str(file, `${p}.author.name`, author.name, LIMITS.maxNameChars)!,
        nickname: str(file, `${p}.author.nickname`, author.nickname, LIMITS.maxNameChars, { optional: true }),
        isBot: author.isBot === true,
      },
      attachmentCount: attachments.length,
      replyTo,
      mentions,
    };
  });

  const seen = new Set<string>();
  for (const m of messages) {
    if (seen.has(m.id)) fail(file, 'messages', `contains message ${m.id} twice`);
    seen.add(m.id);
  }
  // Oldest first; the exporter writes them that way, but do not rely on it.
  messages.sort((a, b) => a.timestamp.localeCompare(b.timestamp) || compareIds(a.id, b.id));

  str(file, 'channel.topic', channel.topic, LIMITS.maxTopicChars, { optional: true });
  return {
    file,
    guildId: snowflake(file, 'guild.id', guild.id),
    guildName: str(file, 'guild.name', guild.name, LIMITS.maxNameChars)!,
    id: snowflake(file, 'channel.id', channel.id),
    type,
    name: str(file, 'channel.name', channel.name, LIMITS.maxNameChars)!,
    categoryId: channel.categoryId === undefined || channel.categoryId === null
      ? null : snowflake(file, 'channel.categoryId', channel.categoryId),
    category: str(file, 'channel.category', channel.category, LIMITS.maxNameChars, { optional: true }),
    isThread: THREAD_TYPES.has(type),
    messages,
  };
}

/**
 * Read every `*.json` export in a directory (not recursive; hidden files and
 * links are ignored). All files must come from the same server, and a channel
 * may appear only once.
 */
export function readExportDir(dir: string): ExportChannel[] {
  const names = readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.json') && !n.startsWith('.')).sort();
  if (names.length === 0) throw new DiscordExportError(`${dir}: no .json export files found`);
  if (names.length > LIMITS.maxFiles) throw new DiscordExportError(`${dir}: more than ${LIMITS.maxFiles} files`);
  const channels: ExportChannel[] = [];
  for (const name of names) {
    const path = join(dir, name);
    const st = lstatSync(path);
    if (!st.isFile()) continue;
    if (st.size > LIMITS.maxFileBytes) throw new DiscordExportError(`${name}: larger than ${LIMITS.maxFileBytes} bytes`);
    channels.push(parseExportJson(readFileSync(path, 'utf-8'), name));
  }
  return checkExportSet(channels);
}

export function checkExportSet(channels: ExportChannel[]): ExportChannel[] {
  if (channels.length === 0) throw new DiscordExportError('no channels in the export');
  const guild = channels[0].guildId;
  const ids = new Map<string, string>();
  for (const c of channels) {
    if (c.guildId !== guild) {
      throw new DiscordExportError(`${c.file}: is from a different server than ${channels[0].file}; import one server at a time`);
    }
    const other = ids.get(c.id);
    if (other) throw new DiscordExportError(`${c.file}: channel ${c.id} is also exported in ${other}`);
    ids.set(c.id, c.file);
  }
  return [...channels].sort((a, b) => compareIds(a.id, b.id));
}

// ── Member list (CSV: Discord user id, display name) ────────────────

export interface ExportMember { id: string; name: string }

/** Minimal RFC 4180 reader: quoted fields, doubled quotes, CRLF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && field === '') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  if (quoted) throw new DiscordExportError('members CSV: unterminated quoted field');
  row.push(field);
  if (row.some((f) => f !== '')) rows.push(row);
  return rows;
}

export function parseMembersCsv(text: string, file = 'members CSV'): ExportMember[] {
  if (text.length > LIMITS.maxMembersCsvBytes) throw new DiscordExportError(`${file}: too large`);
  const rows = parseCsv(text.replace(/^﻿/, ''));
  if (rows.length > 0 && !isSnowflake(rows[0][0]?.trim())) rows.shift(); // header
  if (rows.length > LIMITS.maxMembers) throw new DiscordExportError(`${file}: more than ${LIMITS.maxMembers} rows`);
  const seen = new Set<string>();
  const members: ExportMember[] = [];
  rows.forEach((r, i) => {
    const id = r[0]?.trim();
    const name = (r[1] ?? '').trim();
    if (!isSnowflake(id)) throw new DiscordExportError(`${file}: row ${i + 1}: first column is not a Discord user id`);
    if (!name || name.length > LIMITS.maxNameChars) throw new DiscordExportError(`${file}: row ${i + 1}: name is missing or too long`);
    if (seen.has(id)) return;
    seen.add(id);
    members.push({ id, name });
  });
  return members;
}

export function readMembersCsv(path: string): ExportMember[] {
  const st = lstatSync(path);
  if (!st.isFile() || st.size > LIMITS.maxMembersCsvBytes) throw new DiscordExportError(`${path}: not a file, or too large`);
  return parseMembersCsv(readFileSync(path, 'utf-8'), path);
}

// ── Mapping ─────────────────────────────────────────────────────────

export interface MapOptions {
  /** Copy Discord display names into the records. Off by default. */
  keepNames?: boolean;
  includeBots?: boolean;
  includePrivateThreads?: boolean;
  /** Labels already given in an earlier run of this import (Discord user id → label). */
  pseudonyms?: Record<string, string>;
}

export interface PlannedPost {
  channelId: string;
  messageId: string;
  replyToMessageId?: string;
  text: string;
  createdAt: string;
  editedAt?: string;
  author: string;
  attachmentCount?: number;
}

export interface PlannedThread {
  channelId: string;
  title: string;
  tags: string[];
  createdAt: string;
  /** Where it came from, for the report; never sent. */
  source: { file: string; kind: 'channel' | 'thread' };
  posts: PlannedPost[];
}

export interface ImportReport {
  guild: { id: string; name: string };
  channels: number;
  discordThreads: number;
  threads: number;
  posts: number;
  replies: number;
  edited: number;
  attachments: number;
  truncated: number;
  authors: number;
  skipped: {
    botMessages: number;
    systemMessages: number;
    emptyMessages: number;
    privateThreads: number;
    emptyChannels: number;
  };
}

export interface ImportPlan {
  threads: PlannedThread[];
  /** Discord user id → label shown on posts. Local only: never sent to the PDS. */
  pseudonyms: Record<string, string>;
  /** Discord user id → display name, for the invite list. Local only. */
  names: Record<string, string>;
  /** Discord users whose messages were imported, in order of first appearance. */
  authorIds: string[];
  report: ImportReport;
}

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Cut to at most `maxBytes` of UTF-8 without splitting a character. */
export function truncateBytes(s: string, maxBytes: number, suffix = ''): { text: string; cut: boolean } {
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return { text: s, cut: false };
  const room = maxBytes - Buffer.byteLength(suffix, 'utf8');
  let out = '';
  let used = 0;
  for (const { segment } of segmenter.segment(s)) {
    const b = Buffer.byteLength(segment, 'utf8');
    if (used + b > room) break;
    out += segment;
    used += b;
  }
  return { text: out + suffix, cut: true };
}

const PSEUDONYM = /^Discord member (\d+)$/;

function displayName(u: { name: string; nickname: string | null }): string {
  return (u.nickname && u.nickname.trim()) || u.name;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Turn parsed channels into the threads and posts to send. Deterministic: the
 * same export (and the same earlier labels) always gives the same plan.
 */
export function mapExport(channels: ExportChannel[], options: MapOptions = {}): ImportPlan {
  const pseudonyms: Record<string, string> = { ...(options.pseudonyms ?? {}) };
  let next = Object.values(pseudonyms).reduce((max, label) => {
    const m = PSEUDONYM.exec(label);
    return m ? Math.max(max, Number(m[1])) : max;
  }, 0);
  const names: Record<string, string> = {};
  const authorIds: string[] = [];
  const authorSeen = new Set<string>();

  const label = (u: { id: string; name: string; nickname: string | null }): string => {
    names[u.id] ??= displayName(u);
    if (options.keepNames) return truncateBytes(displayName(u), RECORD_LIMITS.authorBytes).text;
    pseudonyms[u.id] ??= `Discord member ${++next}`;
    return pseudonyms[u.id];
  };

  const report: ImportReport = {
    guild: { id: channels[0]?.guildId ?? '', name: channels[0]?.guildName ?? '' },
    channels: 0, discordThreads: 0, threads: 0, posts: 0, replies: 0, edited: 0, attachments: 0, truncated: 0, authors: 0,
    skipped: { botMessages: 0, systemMessages: 0, emptyMessages: 0, privateThreads: 0, emptyChannels: 0 },
  };
  const threads: PlannedThread[] = [];

  for (const ch of checkExportSet(channels)) {
    if (ch.type === 'GuildPrivateThread' && !options.includePrivateThreads) {
      report.skipped.privateThreads++;
      continue;
    }

    // Which messages are imported decides which replies keep their link.
    const kept = ch.messages.filter((m) => {
      if (!CONTENT_KINDS.has(m.type)) { report.skipped.systemMessages++; return false; }
      if (m.author.isBot && !options.includeBots) { report.skipped.botMessages++; return false; }
      if (!m.content.trim() && m.attachmentCount === 0) { report.skipped.emptyMessages++; return false; }
      return true;
    });
    if (kept.length === 0) {
      report.skipped.emptyChannels++;
      continue;
    }
    const keptIds = new Set(kept.map((m) => m.id));

    const posts = kept.map((m): PlannedPost => {
      const author = label(m.author);
      if (!authorSeen.has(m.author.id)) { authorSeen.add(m.author.id); authorIds.push(m.author.id); }

      let text = m.content;
      // Mentions: the raw form, then the rendered `@name` the exporter writes.
      const mentioned = new Map(m.mentions.map((u) => [u.id, u]));
      text = text.replace(/<@!?([0-9]{1,20})>/g, (whole, id: string) => {
        const u = mentioned.get(id);
        return u ? `@${label(u)}` : (options.keepNames ? whole : '@someone');
      });
      if (!options.keepNames) {
        const spellings: Array<[string, string]> = [];
        for (const u of m.mentions) {
          const to = `@${label(u)}`;
          for (const n of [u.nickname, u.name]) if (n && n.trim()) spellings.push([`@${n}`, to]);
        }
        spellings.sort((a, b) => b[0].length - a[0].length);
        for (const [from, to] of spellings) text = text.replace(new RegExp(escapeRegExp(from), 'g'), to);
      }

      const cut = truncateBytes(text, RECORD_LIMITS.textBytes, '\n\n[…shortened on import]');
      if (cut.cut) report.truncated++;
      const post: PlannedPost = {
        channelId: ch.id,
        messageId: m.id,
        text: cut.text,
        createdAt: m.timestamp,
        author,
      };
      if (m.replyTo && keptIds.has(m.replyTo) && m.replyTo !== m.id) {
        post.replyToMessageId = m.replyTo;
        report.replies++;
      }
      if (m.editedAt) { post.editedAt = m.editedAt; report.edited++; }
      if (m.attachmentCount > 0) { post.attachmentCount = m.attachmentCount; report.attachments += m.attachmentCount; }
      return post;
    });
    // A reply must come after what it answers; with equal timestamps keep that order.
    const position = new Map(posts.map((p, i) => [p.messageId, i]));
    for (const p of posts) {
      if (p.replyToMessageId && position.get(p.replyToMessageId)! > position.get(p.messageId)!) delete p.replyToMessageId;
    }

    const tags = ['discord'];
    let title: string;
    if (ch.isThread) {
      title = ch.name;
      if (ch.category) tags.push(`#${ch.category}`);
      report.discordThreads++;
    } else {
      title = `#${ch.name}`;
      if (ch.category) tags.push(ch.category);
      report.channels++;
    }
    threads.push({
      channelId: ch.id,
      title: truncateBytes(title.trim() || `#${ch.id}`, RECORD_LIMITS.titleBytes).text,
      tags: tags.map((t) => truncateBytes(t, RECORD_LIMITS.tagBytes).text).filter((t) => t.trim()),
      createdAt: posts[0].createdAt,
      source: { file: ch.file, kind: ch.isThread ? 'thread' : 'channel' },
      posts,
    });
    report.threads++;
    report.posts += posts.length;
  }
  report.authors = authorIds.length;

  return { threads, pseudonyms: options.keepNames ? (options.pseudonyms ?? {}) : pseudonyms, names, authorIds, report };
}
