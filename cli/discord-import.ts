/**
 * Running an import (#86, #403): batching, attachments, the checkpoint,
 * retries and the invite list, for Discord and Slack alike. The reading and
 * mapping live in `discord-export.ts` and `slack-export.ts`, which both make
 * an `ImportPlan`; the writing happens on the PDS
 * (`net.openfederation.forum.importBatch`, and `forum.importBlob` for
 * attachments).
 *
 * Resuming has two layers. The PDS derives every record key from the Discord
 * id, so a batch sent twice creates nothing the second time: that alone makes
 * a re-run safe. The checkpoint, a local file, saves the re-sending: it
 * records which threads and how far into each channel the PDS has confirmed,
 * and the labels given to authors ("Discord member 3"), so a resumed or later
 * run numbers people the same way. The checkpoint links those labels to
 * Discord accounts and to invite codes: it is written readable only by its
 * owner and never leaves this machine.
 */
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { ImportPlan, ImportPlatformName, PlannedPost, PlannedThread, ExportMember } from './discord-export.js';
import { readLocalFile, type PlannedAttachment } from './import-files.js';
import { sniffImageType } from '../src/blob/sniff.js';

export const CHECKPOINT_VERSION = 1;
/** The PDS's per-batch caps, and a body size well under its 256 KB JSON limit. */
export const BATCH_LIMITS = { maxThreads: 100, maxPosts: 100, maxBytes: 180_000 } as const;

export interface Checkpoint {
  version: number;
  platform: ImportPlatformName;
  community: string;
  /** The Discord server's id, or the Slack workspace's. */
  guildId: string;
  keepNames: boolean;
  /** Discord (or Slack) user id → label. */
  pseudonyms: Record<string, string>;
  /** Channels whose forum thread the PDS has confirmed. */
  threadsDone: string[];
  /** Channel id → the newest message id the PDS has confirmed in it. */
  postsDoneThrough: Record<string, string>;
  /** Discord user id → invite code already created for them. */
  invites: Record<string, string>;
  updatedAt: string;
}

export function newCheckpoint(
  community: string, guildId: string, keepNames: boolean, platform: ImportPlatformName = 'discord',
): Checkpoint {
  return {
    version: CHECKPOINT_VERSION, platform, community, guildId, keepNames,
    pseudonyms: {}, threadsDone: [], postsDoneThrough: {}, invites: {}, updatedAt: new Date().toISOString(),
  };
}

export function loadCheckpoint(path: string): Checkpoint | null {
  if (!existsSync(path)) return null;
  const data = JSON.parse(readFileSync(path, 'utf-8')) as Checkpoint;
  if (data.version !== CHECKPOINT_VERSION || (data.platform !== 'discord' && data.platform !== 'slack')) {
    throw new Error(`${path}: not a checkpoint this version of ofc understands`);
  }
  return data;
}

/** Owner-only, written beside and moved into place so a crash never leaves half a file. */
export function saveCheckpoint(path: string, cp: Checkpoint): void {
  cp.updatedAt = new Date().toISOString();
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(cp, null, 2), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

/** Refuse a checkpoint that belongs to another import. */
export function assertCheckpointMatches(
  cp: Checkpoint, community: string, guildId: string, keepNames: boolean, platform: ImportPlatformName = 'discord',
): void {
  if (cp.platform !== platform) throw new Error(`the checkpoint is for a ${cp.platform} import, not ${platform}`);
  if (cp.community !== community) throw new Error(`the checkpoint is for community ${cp.community}, not ${community}`);
  const source = platform === 'slack' ? 'Slack workspace' : 'Discord server';
  if (cp.guildId !== guildId) throw new Error(`the checkpoint is for ${source} ${cp.guildId}, not ${guildId}`);
  if (cp.keepNames !== keepNames) {
    throw new Error(`the checkpoint was made ${cp.keepNames ? 'with' : 'without'} --keep-names; run the same way, or start over with a new checkpoint`);
  }
}

// ── Batches ─────────────────────────────────────────────────────────

export interface BlobRef { $type: 'blob'; ref: { $link: string }; mimeType: string; size: number }

/** A post as sent: what was planned, without the local files, with the blobs they became. */
export type SentPost = Omit<PlannedPost, 'attachments'> & { embeds?: BlobRef[] };

export interface ImportBatchBody {
  community: string;
  platform: ImportPlatformName;
  threads?: Array<{ channelId: string; title: string; tags: string[]; createdAt: string }>;
  posts?: SentPost[];
}

export interface PlannedBatch {
  body: ImportBatchBody;
  channelId: string;
  includesThread: boolean;
  lastMessageId: string | null;
  /** Files to upload before sending: which post (by index in `body.posts`) links them. */
  uploads: Array<{ post: number; attachments: PlannedAttachment[] }>;
}

function threadBody(t: PlannedThread) {
  return { channelId: t.channelId, title: t.title, tags: t.tags, createdAt: t.createdAt };
}

/** Source ids in order: Discord snowflakes are numbers; Slack timestamps are seconds and six digits. */
export const sourceOrder = (id: string): bigint => BigInt(id.replace('.', ''));
const isAfter = (id: string, than: string) => sourceOrder(id) > sourceOrder(than);

/**
 * What still has to be sent, in order: per channel, the thread first, then
 * its posts oldest first, in batches the PDS accepts. A batch never spans two
 * channels, so the checkpoint can say how far each channel got.
 */
export function planBatches(plan: ImportPlan, community: string, cp: Checkpoint | null): PlannedBatch[] {
  const batches: PlannedBatch[] = [];
  const done = new Set(cp?.threadsDone ?? []);
  for (const thread of plan.threads) {
    const through = cp?.postsDoneThrough[thread.channelId];
    const posts = through ? thread.posts.filter((p) => isAfter(p.messageId, through)) : thread.posts;
    let includeThread = !done.has(thread.channelId);
    if (!includeThread && posts.length === 0) continue;

    let current: PlannedPost[] = [];
    let size = 0;
    const flush = () => {
      const body: ImportBatchBody = { community, platform: plan.platform ?? 'discord' };
      if (includeThread) body.threads = [threadBody(thread)];
      const uploads: PlannedBatch['uploads'] = [];
      if (current.length > 0) {
        body.posts = current.map(({ attachments, ...sent }, i) => {
          if (attachments && attachments.length > 0) uploads.push({ post: i, attachments });
          return sent;
        });
      }
      batches.push({
        body, channelId: thread.channelId, includesThread: includeThread,
        lastMessageId: current.length > 0 ? current[current.length - 1].messageId : null,
        uploads,
      });
      includeThread = false;
      current = [];
      size = 0;
    };
    for (const post of posts) {
      // Each linked blob adds a ref of about 150 bytes to what is sent.
      const { attachments, ...sent } = post;
      const bytes = Buffer.byteLength(JSON.stringify(sent), 'utf8') + 200 * (attachments?.length ?? 0);
      if (current.length >= BATCH_LIMITS.maxPosts || (current.length > 0 && size + bytes > BATCH_LIMITS.maxBytes)) flush();
      current.push(post);
      size += bytes;
    }
    if (current.length > 0 || includeThread) flush();
  }
  return batches;
}

// ── Running ─────────────────────────────────────────────────────────

type Counts = { created: number; existing: number; deleted?: number };
export interface BatchResult { threads: Counts; posts: Counts }

/** How the runner reaches the PDS; the CLI passes its XRPC client, tests pass the test server. */
export interface ImportTransport {
  importBatch(body: ImportBatchBody): Promise<BatchResult>;
  /** Upload one attachment as a blob of the community (net.openfederation.forum.importBlob). */
  uploadBlob?(community: string, data: Buffer, mimeType: string): Promise<BlobRef>;
  /** With `community`: codes that also join it (#403). */
  createInvites(count: number, note?: string, community?: string): Promise<string[]>;
}

/** An error the transport throws for an HTTP failure, so the runner can tell a rate limit from a refusal. */
export interface StatusError extends Error { status?: number; retryAfterSeconds?: number }

export interface RunOptions {
  checkpointPath: string;
  /** Largest attachment uploaded (default 1,000,000 bytes, the forum.post limit). */
  maxAttachmentBytes?: number;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
  onBatch?: (done: number, total: number, result: BatchResult) => void;
  onWait?: (seconds: number) => void;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function withRetry<T>(fn: () => Promise<T>, opts: RunOptions): Promise<T> {
  const sleep = opts.sleep ?? defaultSleep;
  const max = opts.maxRetries ?? 8;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const e = err as StatusError;
      const retryable = e.status === 429 || e.status === 502 || e.status === 503 || e.status === 504;
      if (!retryable || attempt >= max) throw err;
      const seconds = e.retryAfterSeconds ?? Math.min(60, 5 * 2 ** attempt);
      opts.onWait?.(seconds);
      await sleep(seconds * 1000);
    }
  }
}

export interface RunTotals {
  batches: number;
  threads: { created: number; existing: number; deleted: number };
  posts: { created: number; existing: number; deleted: number };
  /** Attachments uploaded and linked, and those the PDS refused or that changed on disk since the plan. */
  attachments: { uploaded: number; skipped: number };
}

/**
 * Upload a batch's files and put the blobs on their posts. A file the PDS
 * refuses (its type or size) or that is no longer what the plan saw is left
 * out and counted, and the post goes without it: it still says how many
 * attachments the message had.
 */
async function uploadAttachments(
  batch: PlannedBatch, transport: ImportTransport, opts: RunOptions, totals: RunTotals,
): Promise<void> {
  if (batch.uploads.length === 0) return;
  if (!transport.uploadBlob) throw new Error('this transport cannot upload attachments');
  const max = opts.maxAttachmentBytes ?? 1_000_000;
  for (const { post, attachments } of batch.uploads) {
    const embeds: BlobRef[] = [];
    for (const a of attachments) {
      let data: Buffer;
      try {
        data = readLocalFile(a.file, max);
      } catch {
        totals.attachments.skipped++;
        continue;
      }
      const type = sniffImageType(data);
      if (!type || type !== a.mimeType) { totals.attachments.skipped++; continue; }
      try {
        embeds.push(await withRetry(() => transport.uploadBlob!(batch.body.community, data, type), opts));
        totals.attachments.uploaded++;
      } catch (err) {
        const status = (err as StatusError).status;
        if (status === 400 || status === 413) { totals.attachments.skipped++; continue; }
        throw err;
      }
    }
    if (embeds.length > 0) batch.body.posts![post].embeds = embeds;
  }
}

/**
 * Send every batch still to do, saving the checkpoint after each one the PDS
 * confirms. Stops at the first refusal (a malformed batch, a permission
 * problem): what was confirmed stays confirmed, and the next run resumes.
 */
export async function runImport(
  plan: ImportPlan,
  cp: Checkpoint,
  transport: ImportTransport,
  opts: RunOptions,
): Promise<RunTotals> {
  // The labels this run used are the ones the next must use.
  cp.pseudonyms = { ...cp.pseudonyms, ...plan.pseudonyms };
  saveCheckpoint(opts.checkpointPath, cp);

  const batches = planBatches(plan, cp.community, cp);
  const totals: RunTotals = {
    batches: 0, threads: { created: 0, existing: 0, deleted: 0 }, posts: { created: 0, existing: 0, deleted: 0 },
    attachments: { uploaded: 0, skipped: 0 },
  };
  for (const [i, batch] of batches.entries()) {
    await uploadAttachments(batch, transport, opts, totals);
    const result = await withRetry(() => transport.importBatch(batch.body), opts);
    if (batch.includesThread && !cp.threadsDone.includes(batch.channelId)) cp.threadsDone.push(batch.channelId);
    if (batch.lastMessageId) cp.postsDoneThrough[batch.channelId] = batch.lastMessageId;
    saveCheckpoint(opts.checkpointPath, cp);
    totals.batches++;
    totals.threads.created += result.threads.created;
    totals.threads.existing += result.threads.existing;
    totals.posts.created += result.posts.created;
    totals.posts.existing += result.posts.existing;
    totals.threads.deleted += result.threads.deleted ?? 0;
    totals.posts.deleted += result.posts.deleted ?? 0;
    opts.onBatch?.(i + 1, batches.length, result);
  }
  return totals;
}

// ── Invites ─────────────────────────────────────────────────────────

export interface InviteRow { discordUserId: string; discordName: string; importedAs: string; code: string }

/** Who gets an invite: the member list when given, else everyone whose messages were imported. */
export function inviteesFor(plan: ImportPlan, members: ExportMember[] | null): ExportMember[] {
  if (members) return members;
  return plan.authorIds.map((id) => ({ id, name: plan.names[id] ?? id }));
}

/**
 * One single-use invite code per person, created in chunks of up to 100 and
 * remembered in the checkpoint, so a re-run gives each person the same code
 * rather than a new one. The PDS stores nothing about who a code is for
 * beyond `note`, which is empty unless the organiser sets one. With
 * `community`, the codes also join that community (#403).
 */
export async function createInvites(
  invitees: ExportMember[],
  plan: ImportPlan,
  cp: Checkpoint,
  transport: ImportTransport,
  opts: RunOptions & { note?: string; community?: string },
): Promise<InviteRow[]> {
  const missing = invitees.filter((m) => !cp.invites[m.id]);
  for (let i = 0; i < missing.length; i += 100) {
    const chunk = missing.slice(i, i + 100);
    const codes = await withRetry(() => transport.createInvites(chunk.length, opts.note, opts.community), opts);
    if (codes.length !== chunk.length) throw new Error(`asked for ${chunk.length} invite codes, got ${codes.length}`);
    chunk.forEach((m, j) => { cp.invites[m.id] = codes[j]; });
    saveCheckpoint(opts.checkpointPath, cp);
  }
  return invitees.map((m) => ({
    discordUserId: m.id,
    discordName: m.name,
    importedAs: cp.keepNames ? (plan.names[m.id] ?? '') : (cp.pseudonyms[m.id] ?? plan.pseudonyms[m.id] ?? ''),
    code: cp.invites[m.id],
  }));
}

/** A CSV field, quoted, and defused for spreadsheets (a leading = + - @ is a formula). */
export function csvField(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}

export function invitesCsv(rows: InviteRow[], registerUrl: string, platform: ImportPlatformName = 'discord'): string {
  const header = [`${platform}_user_id`, `${platform}_name`, 'imported_as', 'invite_code', 'invite_link'];
  const lines = [header.join(',')];
  for (const r of rows) {
    const link = `${registerUrl}?invite=${encodeURIComponent(r.code)}`;
    lines.push([r.discordUserId, r.discordName, r.importedAs, r.code, link].map(csvField).join(','));
  }
  return lines.join('\n') + '\n';
}

/** Write a local file only its owner can read. */
export function writePrivateFile(path: string, content: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, content, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}
