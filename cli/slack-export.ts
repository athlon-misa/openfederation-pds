/**
 * Reading a Slack workspace export and mapping it to forum threads and posts
 * (#403), the same way a Discord export is mapped (`discord-export.ts`): the
 * plan it makes goes through the same runner, checkpoint and endpoint.
 *
 * Input: the export Slack gives a workspace admin, as the `.zip` or unpacked:
 * `users.json`, `channels.json` (and `groups.json` for private channels when
 * the export has them), and one folder per channel, named after it, with one
 * JSON file per day (`2026-01-05.json`, a list of messages). It is treated as
 * untrusted: sizes are capped, every field used is checked, and a file that
 * does not look like an export is refused with the reason. No Slack token is
 * involved anywhere.
 *
 * Mapping:
 *  - each channel becomes a forum thread titled `#name`, tagged `slack`.
 *  - each message becomes a post, oldest first, keeping its original time.
 *    A thread reply (`thread_ts`) becomes a reply to the thread's first
 *    message, when that was imported; "also send to channel" replies too.
 *  - kept: ordinary messages, `/me` messages, file shares. Skipped and
 *    counted: bots and apps (unless asked for); joins, leaves, topic and
 *    purpose changes, renames, pins, archiving, huddles, reminders and every
 *    other notice; messages deleted on Slack (a "This message was deleted."
 *    placeholder, `tombstone`); empty messages; the same message appearing
 *    twice. Edits keep the last text, and `editedAt`.
 *  - private channels are skipped unless asked for; direct and group
 *    messages (`dms.json`, `mpims.json`) are never read.
 *  - authors are "Slack member 1", "Slack member 2"… in order of first
 *    appearance unless names are kept. Slack user ids never reach the PDS.
 *    `<@U123>` mentions, and names typed as plain text, are rewritten;
 *    `<#C123|name>` becomes `#name` for a channel being imported and
 *    `#channel` otherwise; links become `label (url)`.
 *  - attachments are uploaded only from files inside the export
 *    (`<channel>/attachments/<file id>-<name>`, as slackdump writes them, or
 *    `__uploads/<file id>/<name>`); `url_private` links are never fetched.
 */
import { basename } from 'node:path';
import {
  chooseAttachments, emptyAttachmentCounts, openExport, ExportFileError,
  type AttachmentCandidate, type AttachmentOptions, type ExportTree,
} from './import-files.js';
import { buildNameMatcher, replacePlainNames, replacementList, type NameReplacements } from './import-names.js';
import { RECORD_LIMITS, truncateBytes, type ImportPlan, type ImportReport, type PlannedPost, type PlannedThread } from './discord-export.js';

export const SLACK_LIMITS = {
  maxFileBytes: 128 * 1024 * 1024,
  maxChannels: 5000,
  maxDayFiles: 200_000,
  maxMessagesPerFile: 1_000_000,
  /** Slack allows 40,000 characters; anything far beyond is not a real export. */
  maxTextChars: 50_000,
  maxNameChars: 200,
  maxFiles: 100,
  maxUsers: 500_000,
} as const;

export class SlackExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SlackExportError';
  }
}

const USER_ID = /^[UWB][A-Z0-9]{2,30}$/;
const CHANNEL_ID = /^[CG][A-Z0-9]{2,30}$/;
const TEAM_ID = /^[TE][A-Z0-9]{2,30}$/;
const FILE_ID = /^F[A-Z0-9]{2,30}$/;
const TS = /^[0-9]{9,10}\.[0-9]{6}$/;
/** 2013-01-01 plus a few minutes: the PDS gives no record key to anything earlier. */
const MIN_TS_SECONDS = 1356998700;
const DAY_FILE = /^\d{4}-\d{2}-\d{2}\.json$/;

/** Kinds of message that are someone writing something; any other subtype is a notice. */
const CONTENT_SUBTYPES = new Set([undefined, 'thread_broadcast', 'file_share', 'me_message']);

export interface SlackUser {
  id: string;
  teamId: string | null;
  name: string;
  realName: string | null;
  displayName: string | null;
  isBot: boolean;
}

export interface SlackFile { id: string; name: string; size: number | null; mode: string | null; hasUrl: boolean }

export interface SlackMessage {
  ts: string;
  threadTs: string | null;
  user: string | null;
  botId: string | null;
  subtype: string | undefined;
  hidden: boolean;
  text: string;
  editedTs: string | null;
  files: SlackFile[];
}

export interface SlackChannel {
  id: string;
  name: string;
  isPrivate: boolean;
  isArchived: boolean;
  messages: SlackMessage[];
  /** Day files read. */
  days: number;
  duplicates: number;
}

export interface SlackExport {
  tree: ExportTree;
  teamId: string;
  name: string;
  users: Map<string, SlackUser>;
  channels: SlackChannel[];
  /** Private channels in the export that were not read. */
  privateChannelsSkipped: number;
  /** Direct and group-message conversations listed in the export (never read). */
  directMessages: number;
}

// ── Validation helpers ─────────────────────────────────────────────

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function fail(file: string, path: string, why: string): never {
  throw new SlackExportError(`${file}: ${path} ${why}`);
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

function id(file: string, path: string, v: unknown, pattern: RegExp, what: string): string {
  if (typeof v !== 'string' || !pattern.test(v)) fail(file, path, `is not a Slack ${what} id`);
  return v;
}

function ts(file: string, path: string, v: unknown): string {
  if (typeof v !== 'string' || !TS.test(v)) fail(file, path, 'is not a Slack timestamp');
  return v;
}

export function tsMicros(t: string): bigint {
  const [s, f] = t.split('.');
  return BigInt(s) * 1_000_000n + BigInt(f);
}

export function tsToIso(t: string): string {
  return new Date(Number(tsMicros(t) / 1000n)).toISOString();
}

function readJson(tree: ExportTree, path: string): unknown {
  const size = tree.size(path);
  if (size === null) throw new SlackExportError(`${tree.label}: ${path} is missing (is this a Slack export?)`);
  if (size > SLACK_LIMITS.maxFileBytes) throw new SlackExportError(`${path}: larger than ${SLACK_LIMITS.maxFileBytes} bytes`);
  let text: string;
  try {
    text = tree.read(path, SLACK_LIMITS.maxFileBytes).toString('utf8');
  } catch (err) {
    if (err instanceof ExportFileError) throw new SlackExportError(err.message);
    throw err;
  }
  try {
    return JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    throw new SlackExportError(`${path}: not valid JSON`);
  }
}

// ── Parsing ─────────────────────────────────────────────────────────

export function parseUsers(doc: unknown, file = 'users.json'): Map<string, SlackUser> {
  if (!Array.isArray(doc)) fail(file, '$', 'is not a list');
  if (doc.length > SLACK_LIMITS.maxUsers) fail(file, '$', 'has too many entries');
  const users = new Map<string, SlackUser>();
  doc.forEach((u: unknown, i: number) => {
    const p = `[${i}]`;
    if (!isObject(u)) fail(file, p, 'is not an object');
    const profile = isObject(u.profile) ? u.profile : {};
    const user: SlackUser = {
      id: id(file, `${p}.id`, u.id, USER_ID, 'user'),
      teamId: typeof u.team_id === 'string' && TEAM_ID.test(u.team_id) ? u.team_id : null,
      name: str(file, `${p}.name`, u.name ?? '', SLACK_LIMITS.maxNameChars)!,
      realName: str(file, `${p}.real_name`, u.real_name ?? profile.real_name, SLACK_LIMITS.maxNameChars, { optional: true }),
      displayName: str(file, `${p}.profile.display_name`, profile.display_name, SLACK_LIMITS.maxNameChars, { optional: true }),
      isBot: u.is_bot === true || u.is_app_user === true || u.id === 'USLACKBOT',
    };
    users.set(user.id, user);
  });
  return users;
}

function parseFiles(file: string, p: string, v: unknown): SlackFile[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > SLACK_LIMITS.maxFiles) fail(file, p, 'is not a short list');
  return v.map((f: unknown, j: number): SlackFile => {
    const fp = `${p}[${j}]`;
    if (!isObject(f)) fail(file, fp, 'is not an object');
    const size = f.size;
    return {
      id: typeof f.id === 'string' && FILE_ID.test(f.id) ? f.id : '',
      name: str(file, `${fp}.name`, f.name ?? '', 1024)!,
      size: typeof size === 'number' && Number.isSafeInteger(size) && size >= 0 ? size : null,
      mode: typeof f.mode === 'string' ? f.mode : null,
      hasUrl: typeof f.url_private === 'string' || typeof f.url_private_download === 'string',
    };
  });
}

export function parseDay(doc: unknown, file: string): SlackMessage[] {
  if (!Array.isArray(doc)) fail(file, '$', 'is not a list of messages');
  if (doc.length > SLACK_LIMITS.maxMessagesPerFile) fail(file, '$', 'has too many entries');
  const out: SlackMessage[] = [];
  doc.forEach((m: unknown, i: number) => {
    const p = `[${i}]`;
    if (!isObject(m)) fail(file, p, 'is not an object');
    // Not a message at all: nothing to import, and nothing to check further.
    if (m.type !== 'message') return;
    const edited = isObject(m.edited) && typeof m.edited.ts === 'string' && TS.test(m.edited.ts) ? m.edited.ts : null;
    const subtype = typeof m.subtype === 'string' ? str(file, `${p}.subtype`, m.subtype, 64)! : undefined;
    out.push({
      ts: ts(file, `${p}.ts`, m.ts),
      threadTs: m.thread_ts === undefined || m.thread_ts === null ? null : ts(file, `${p}.thread_ts`, m.thread_ts),
      user: typeof m.user === 'string' && USER_ID.test(m.user) ? m.user : null,
      botId: typeof m.bot_id === 'string' && m.bot_id ? m.bot_id : null,
      subtype,
      hidden: m.hidden === true,
      text: str(file, `${p}.text`, m.text ?? '', SLACK_LIMITS.maxTextChars)!,
      editedTs: edited,
      files: parseFiles(file, `${p}.files`, m.files),
    });
  });
  return out;
}

interface ChannelEntry { id: string; name: string; isPrivate: boolean; isArchived: boolean }

function parseChannels(doc: unknown, file: string, isPrivate: boolean): ChannelEntry[] {
  if (!Array.isArray(doc)) fail(file, '$', 'is not a list');
  if (doc.length > SLACK_LIMITS.maxChannels) fail(file, '$', 'has too many entries');
  return doc.map((c: unknown, i: number): ChannelEntry => {
    const p = `[${i}]`;
    if (!isObject(c)) fail(file, p, 'is not an object');
    const name = str(file, `${p}.name`, c.name, 80)!;
    if (!name || name.includes('/') || name.includes('\\') || name === '.' || name === '..' || name.startsWith('.')) {
      fail(file, `${p}.name`, 'is not a channel name');
    }
    return {
      id: id(file, `${p}.id`, c.id, CHANNEL_ID, 'channel'),
      name,
      isPrivate: isPrivate || c.is_private === true,
      isArchived: c.is_archived === true,
    };
  });
}

function count(tree: ExportTree, file: string): number {
  if (!tree.isFile(file)) return 0;
  const doc = readJson(tree, file);
  return Array.isArray(doc) ? doc.length : 0;
}

export interface ReadOptions { includePrivateChannels?: boolean }

/** Read an export (a folder or a `.zip`). The caller closes `tree` when done. */
export function readSlackExport(path: string, opts: ReadOptions = {}): SlackExport {
  let tree: ExportTree;
  try {
    tree = openExport(path);
  } catch (err) {
    if (err instanceof ExportFileError) throw new SlackExportError(err.message);
    throw err;
  }
  try {
    if (!tree.isFile('channels.json')) {
      throw new SlackExportError(`${path}: no channels.json (is this a Slack workspace export?)`);
    }
    if (!tree.isFile('users.json')) throw new SlackExportError(`${path}: no users.json (is this a Slack workspace export?)`);
    const users = parseUsers(readJson(tree, 'users.json'));
    const entries = [
      ...parseChannels(readJson(tree, 'channels.json'), 'channels.json', false),
      ...(tree.isFile('groups.json') ? parseChannels(readJson(tree, 'groups.json'), 'groups.json', true) : []),
    ];
    const ids = new Set<string>();
    const names = new Set<string>();
    for (const e of entries) {
      if (ids.has(e.id)) throw new SlackExportError(`channel ${e.id} is listed twice`);
      if (names.has(e.name)) throw new SlackExportError(`two channels are called ${e.name}`);
      ids.add(e.id);
      names.add(e.name);
    }

    let privateChannelsSkipped = 0;
    let dayFiles = 0;
    const channels: SlackChannel[] = [];
    for (const e of entries) {
      if (e.isPrivate && !opts.includePrivateChannels) { privateChannelsSkipped++; continue; }
      const days = tree.isDir(e.name) ? tree.list(e.name).filter((n) => DAY_FILE.test(n)) : [];
      dayFiles += days.length;
      if (dayFiles > SLACK_LIMITS.maxDayFiles) throw new SlackExportError(`more than ${SLACK_LIMITS.maxDayFiles} day files`);
      const byTs = new Map<string, SlackMessage>();
      let duplicates = 0;
      for (const day of days) {
        const file = `${e.name}/${day}`;
        for (const m of parseDay(readJson(tree, file), file)) {
          if (byTs.has(m.ts)) { duplicates++; continue; }
          byTs.set(m.ts, m);
        }
      }
      const messages = [...byTs.values()].sort((a, b) => {
        const x = tsMicros(a.ts), y = tsMicros(b.ts);
        return x < y ? -1 : x > y ? 1 : 0;
      });
      channels.push({ id: e.id, name: e.name, isPrivate: e.isPrivate, isArchived: e.isArchived, messages, days: days.length, duplicates });
    }

    // The workspace: Slack writes its id on every user.
    const teams = new Map<string, number>();
    for (const u of users.values()) if (u.teamId) teams.set(u.teamId, (teams.get(u.teamId) ?? 0) + 1);
    const teamId = [...teams.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? 'T0UNKNOWN';
    const directMessages = count(tree, 'dms.json') + count(tree, 'mpims.json');
    return {
      tree, teamId, name: basename(path).replace(/\.zip$/i, ''), users, channels, privateChannelsSkipped, directMessages,
    };
  } catch (err) {
    tree.close();
    throw err;
  }
}

// ── Mapping ─────────────────────────────────────────────────────────

export interface SlackMapOptions {
  keepNames?: boolean;
  includeBots?: boolean;
  /** Labels already given in an earlier run of this import (Slack user id → label). */
  pseudonyms?: Record<string, string>;
  /** Also replace names typed as plain text (default true; ignored with keepNames). */
  plainNames?: boolean;
  attachments?: AttachmentOptions;
}

const PSEUDONYM = /^Slack member (\d+)$/;

export function displayName(u: SlackUser): string {
  return (u.displayName && u.displayName.trim()) || (u.realName && u.realName.trim()) || u.name || u.id;
}

const ENTITIES: Record<string, string> = { '&lt;': '<', '&gt;': '>', '&amp;': '&' };

/**
 * Slack's markup to plain text: `<@U…>` through `mention`, `<#C…|name>`
 * through `channel`, special mentions, links; then the three entities Slack
 * escapes.
 */
export function slackText(
  text: string,
  mention: (userId: string, shown: string | null) => string,
  channel: (channelId: string, shown: string | null) => string,
): string {
  const out = text.replace(/<([^<>\n]{1,2000})>/g, (whole, inner: string) => {
    const bar = inner.indexOf('|');
    const target = bar >= 0 ? inner.slice(0, bar) : inner;
    const shown = bar >= 0 ? inner.slice(bar + 1) : null;
    if (target.startsWith('@')) {
      const uid = target.slice(1);
      return USER_ID.test(uid) ? mention(uid, shown) : whole;
    }
    if (target.startsWith('#')) {
      const cid = target.slice(1);
      return CHANNEL_ID.test(cid) ? channel(cid, shown) : whole;
    }
    if (target.startsWith('!')) {
      const special = target.slice(1);
      if (special === 'here' || special === 'channel' || special === 'everyone') return `@${special}`;
      if (special.startsWith('subteam^')) return shown ? (shown.startsWith('@') ? shown : `@${shown}`) : '@group';
      return shown ?? '';
    }
    if (/^(https?|mailto|tel):/i.test(target)) {
      if (!shown || shown === target) return target;
      return target.toLowerCase().startsWith('mailto:') || target.toLowerCase().startsWith('tel:') ? shown : `${shown} (${target})`;
    }
    return whole;
  });
  return out.replace(/&(lt|gt|amp);/g, (e) => ENTITIES[e]);
}

/**
 * Turn a read export into the threads and posts to send. Deterministic: the
 * same export (and the same earlier labels) always gives the same plan.
 */
export function mapSlackExport(exp: SlackExport, options: SlackMapOptions = {}): ImportPlan {
  const pseudonyms: Record<string, string> = { ...(options.pseudonyms ?? {}) };
  let next = Object.values(pseudonyms).reduce((max, l) => {
    const m = PSEUDONYM.exec(l);
    return m ? Math.max(max, Number(m[1])) : max;
  }, 0);
  const names: Record<string, string> = {};
  const authorIds: string[] = [];
  const authorSeen = new Set<string>();
  const userOf = (uid: string): SlackUser => exp.users.get(uid) ?? {
    id: uid, teamId: null, name: uid, realName: null, displayName: null, isBot: false,
  };
  const label = (uid: string): string => {
    const u = userOf(uid);
    names[uid] ??= displayName(u);
    if (options.keepNames) return truncateBytes(displayName(u), RECORD_LIMITS.authorBytes).text;
    pseudonyms[uid] ??= `Slack member ${++next}`;
    return pseudonyms[uid];
  };

  const plainNames = !options.keepNames && options.plainNames !== false;
  const matcher = buildNameMatcher(plainNames
    ? [...exp.users.values()].map((u) => ({ id: u.id, names: [u.displayName, u.realName, u.name] }))
    : []);
  const replaced: NameReplacements = new Map();
  const imported = new Map(exp.channels.map((c) => [c.id, c.name]));

  const report: ImportReport = {
    platform: 'slack',
    guild: { id: exp.teamId, name: exp.name },
    channels: 0, sourceThreads: 0, threads: 0, posts: 0, replies: 0, edited: 0, attachments: 0,
    attachmentFiles: emptyAttachmentCounts(), namesReplaced: 0, truncated: 0, authors: 0,
    skipped: {
      botMessages: 0, systemMessages: 0, emptyMessages: 0, privateThreads: 0, emptyChannels: 0,
      privateChannels: exp.privateChannelsSkipped, directMessages: exp.directMessages,
      deletedMessages: 0, duplicateMessages: exp.channels.reduce((n, c) => n + c.duplicates, 0),
    },
  };
  const threads: PlannedThread[] = [];

  const attachmentsOf = (ch: SlackChannel, m: SlackMessage): AttachmentCandidate[] => m.files.map((f) => {
    if (f.mode === 'tombstone') return { fileName: f.name, file: null, size: f.size, deleted: true };
    const safeName = f.id && f.name && !/[/\\\0]/.test(f.name) && f.name !== '.' && f.name !== '..';
    if (safeName) {
      for (const path of [`${ch.name}/attachments/${f.id}-${f.name}`, `__uploads/${f.id}/${f.name}`]) {
        if (exp.tree.isFile(path)) return { fileName: f.name, file: exp.tree.ref(path), size: exp.tree.size(path) };
      }
    }
    return { fileName: f.name, file: null, size: f.size, remoteOnly: f.hasUrl || f.mode === 'external' };
  });

  for (const ch of exp.channels) {
    const kept = ch.messages.filter((m) => {
      if (m.subtype === 'tombstone') { report.skipped.deletedMessages!++; return false; }
      if (m.hidden || (!CONTENT_SUBTYPES.has(m.subtype) && m.subtype !== 'bot_message')) {
        report.skipped.systemMessages++;
        return false;
      }
      // A person posting through an app still has their user id; a bot has none, or a bot account.
      const isBot = m.subtype === 'bot_message' || (m.user ? userOf(m.user).isBot : !!m.botId);
      if (isBot && !options.includeBots) { report.skipped.botMessages++; return false; }
      if (!m.user && !m.botId) { report.skipped.systemMessages++; return false; }
      if (!m.text.trim() && m.files.length === 0) { report.skipped.emptyMessages++; return false; }
      if (Number(m.ts.split('.')[0]) < MIN_TS_SECONDS) { report.skipped.systemMessages++; return false; }
      return true;
    });
    if (kept.length === 0) {
      report.skipped.emptyChannels++;
      continue;
    }
    const keptTs = new Set(kept.map((m) => m.ts));
    const threadParents = new Set<string>();

    const posts = kept.map((m): PlannedPost => {
      // A bot (when asked for) is labelled by its bot id, as one more author.
      const authorId = m.user ?? `bot:${m.botId}`;
      const author = label(authorId);
      // Bots get no invite.
      if (m.user && !authorSeen.has(authorId)) { authorSeen.add(authorId); authorIds.push(authorId); }

      let text = slackText(
        m.text,
        (uid, shown) => {
          if (exp.users.has(uid)) return `@${label(uid)}`;
          return options.keepNames && shown ? `@${shown}` : '@someone';
        },
        (cid, shown) => (imported.has(cid) ? `#${imported.get(cid)}` : (options.keepNames && shown ? `#${shown}` : '#channel')),
      );
      if (plainNames) text = replacePlainNames(text, matcher, label, replaced);
      if (m.subtype === 'me_message') text = `_${text}_`;

      const cut = truncateBytes(text, RECORD_LIMITS.textBytes, '\n\n[…shortened on import]');
      if (cut.cut) report.truncated++;
      const post: PlannedPost = { channelId: ch.id, messageId: m.ts, text: cut.text, createdAt: tsToIso(m.ts), author };
      if (m.threadTs && m.threadTs !== m.ts && keptTs.has(m.threadTs) && tsMicros(m.threadTs) < tsMicros(m.ts)) {
        post.replyToMessageId = m.threadTs;
        threadParents.add(m.threadTs);
        report.replies++;
      }
      if (m.editedTs) { post.editedAt = tsToIso(m.editedTs); report.edited++; }
      if (m.files.length > 0) {
        post.attachmentCount = m.files.length;
        report.attachments += m.files.length;
        const files = chooseAttachments(attachmentsOf(ch, m), report.attachmentFiles, options.attachments);
        if (files.length > 0) post.attachments = files;
      }
      return post;
    });
    report.sourceThreads += threadParents.size;

    threads.push({
      channelId: ch.id,
      title: truncateBytes(`#${ch.name}`, RECORD_LIMITS.titleBytes).text,
      tags: ['slack'],
      createdAt: posts[0].createdAt,
      source: { file: ch.name, kind: 'channel' },
      posts,
    });
    report.channels++;
    report.threads++;
    report.posts += posts.length;
  }
  report.authors = authorIds.length;
  const namesReplaced = replacementList(replaced);
  report.namesReplaced = namesReplaced.reduce((n, r) => n + r.count, 0);

  return {
    platform: 'slack', threads, pseudonyms: options.keepNames ? (options.pseudonyms ?? {}) : pseudonyms,
    names, authorIds, namesReplaced, report,
  };
}
