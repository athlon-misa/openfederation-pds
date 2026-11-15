/**
 * Local files of an import (#403): the export's own files, read from a folder
 * or a zip, and the attachments that come with it.
 *
 * Attachments are only ever read from the organiser's disk: a folder
 * DiscordChatExporter wrote with its media (`--media`), or the files a Slack
 * export carries. A link to the platform's servers (Discord's CDN, Slack's
 * `url_private`) is never fetched: those links expire, and they carry tokens
 * that would be sent along. Nothing in this module opens a network
 * connection.
 *
 * A file must stay inside the export: no absolute paths, no `..`, no
 * symbolic links. An attachment is uploaded only when it is an image of a
 * type the PDS takes, judged by its bytes (`sniffImageType`, the server's own
 * check), and no larger than the limit; everything else is counted and left
 * out, never uploaded "just in case". The forum.post lexicon allows four
 * images per post.
 */
import { lstatSync, openSync, readSync, closeSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { sniffImageType, SNIFF_BYTES, type SniffedImageType } from '../src/blob/sniff.js';
import { ZipArchive, ZipError, safeEntryName } from './zip-reader.js';

/** forum.post `embeds`: at most 4 images of at most 1,000,000 bytes. */
export const MAX_EMBEDS_PER_POST = 4;
export const DEFAULT_MAX_ATTACHMENT_BYTES = 1_000_000;

export type LocalFile = { kind: 'fs'; path: string } | { kind: 'zip'; zip: string; entry: string };

export class ExportFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExportFileError';
  }
}

// ── An export: a folder or a zip ─────────────────────────────────────

export interface ExportTree {
  /** For messages: the folder or zip it was read from. */
  readonly label: string;
  /** Names of the files and folders directly under `dir` ('' is the top). */
  list(dir: string): string[];
  isFile(path: string): boolean;
  isDir(path: string): boolean;
  size(path: string): number | null;
  read(path: string, maxBytes: number): Buffer;
  /** How to read the file again later (an attachment, at upload time). */
  ref(path: string): LocalFile;
  close(): void;
}

const clean = (p: string) => p.split('/').filter(Boolean).join('/');

/** A folder on disk. Paths are relative to it; links and anything outside it are invisible. */
export function folderTree(root: string): ExportTree {
  const base = realpathSync(root);
  const abs = (p: string): string | null => {
    const rel = clean(p);
    if (rel && !safeEntryName(rel)) return null;
    const full = resolve(base, rel);
    const back = relative(base, full);
    if (back.startsWith('..') || isAbsolute(back)) return null;
    return full;
  };
  const stat = (p: string) => {
    const full = abs(p);
    if (!full) return null;
    try {
      // Every component, so a linked folder cannot lead outside.
      let at = base;
      for (const seg of relative(base, full).split(sep).filter(Boolean)) {
        at = join(at, seg);
        if (lstatSync(at).isSymbolicLink()) return null;
      }
      return { full, st: lstatSync(full) };
    } catch {
      return null;
    }
  };
  return {
    label: root,
    list(dir) {
      const s = stat(dir);
      if (!s || !s.st.isDirectory()) return [];
      return readdirSync(s.full).filter((n) => !n.startsWith('.')).sort();
    },
    isFile: (p) => !!stat(p)?.st.isFile(),
    isDir: (p) => !!stat(p)?.st.isDirectory(),
    size: (p) => { const s = stat(p); return s?.st.isFile() ? s.st.size : null; },
    read(p, maxBytes) {
      const s = stat(p);
      if (!s || !s.st.isFile()) throw new ExportFileError(`${p}: not a file in the export`);
      if (s.st.size > maxBytes) throw new ExportFileError(`${p}: larger than ${maxBytes} bytes`);
      return readFileSync(s.full);
    },
    ref(p) {
      const s = stat(p);
      if (!s) throw new ExportFileError(`${p}: not in the export`);
      return { kind: 'fs', path: s.full };
    },
    close() {},
  };
}

/**
 * A zip. When everything in it sits in one top folder (as when a folder was
 * zipped), paths are relative to that folder.
 */
export function zipTree(path: string): ExportTree {
  let zip: ZipArchive;
  try {
    zip = ZipArchive.open(path);
  } catch (err) {
    if (err instanceof ZipError) throw new ExportFileError(err.message);
    throw err;
  }
  const names = [...zip.entries.keys()];
  const tops = new Set(names.map((n) => n.split('/')[0]));
  const prefix = tops.size === 1 && names.every((n) => n.includes('/')) ? `${[...tops][0]}/` : '';
  const files = new Map<string, string>(); // path inside the export → entry name
  const dirs = new Set<string>(['']);
  for (const n of names) {
    if (!n.startsWith(prefix)) continue;
    const p = n.slice(prefix.length);
    if (!p) continue;
    files.set(p, n);
    const segs = p.split('/');
    for (let i = 1; i < segs.length; i++) dirs.add(segs.slice(0, i).join('/'));
  }
  return {
    label: path,
    list(dir) {
      const d = clean(dir);
      const out = new Set<string>();
      const lead = d ? `${d}/` : '';
      for (const p of [...files.keys(), ...dirs]) {
        if (p && p.startsWith(lead) && p !== d) {
          const name = p.slice(lead.length).split('/')[0];
          if (name && !name.startsWith('.')) out.add(name);
        }
      }
      return [...out].sort();
    },
    isFile: (p) => files.has(clean(p)),
    isDir: (p) => dirs.has(clean(p)),
    size: (p) => { const e = files.get(clean(p)); return e ? zip.entries.get(e)!.size : null; },
    read(p, maxBytes) {
      const e = files.get(clean(p));
      if (!e) throw new ExportFileError(`${p}: not in ${path}`);
      try {
        return zip.readEntry(e, maxBytes);
      } catch (err) {
        if (err instanceof ZipError) throw new ExportFileError(err.message);
        throw err;
      }
    },
    ref(p) {
      const e = files.get(clean(p));
      if (!e) throw new ExportFileError(`${p}: not in ${path}`);
      return { kind: 'zip', zip: path, entry: e };
    },
    close: () => zip.close(),
  };
}

export function openExport(path: string): ExportTree {
  const st = lstatSync(path);
  if (st.isDirectory()) return folderTree(path);
  if (st.isFile()) return zipTree(path);
  throw new ExportFileError(`${path}: not a folder or a zip file`);
}

// ── Reading an attachment again, at upload time ──────────────────────

const zips = new Map<string, ZipArchive>();

/** The file's bytes, at most `maxBytes`. Local only. */
export function readLocalFile(file: LocalFile, maxBytes: number): Buffer {
  if (file.kind === 'fs') {
    const st = lstatSync(file.path);
    if (!st.isFile()) throw new ExportFileError(`${file.path}: not a regular file`);
    if (st.size > maxBytes) throw new ExportFileError(`${file.path}: larger than ${maxBytes} bytes`);
    return readFileSync(file.path);
  }
  let zip = zips.get(file.zip);
  if (!zip) { zip = ZipArchive.open(file.zip); zips.set(file.zip, zip); }
  return zip.readEntry(file.entry, maxBytes);
}

function readHead(file: LocalFile, maxBytes: number): Buffer {
  if (file.kind === 'fs') {
    const fd = openSync(file.path, 'r');
    try {
      const buf = Buffer.alloc(SNIFF_BYTES);
      const n = readSync(fd, buf, 0, SNIFF_BYTES, 0);
      return buf.subarray(0, n);
    } finally {
      closeSync(fd);
    }
  }
  return readLocalFile(file, maxBytes).subarray(0, SNIFF_BYTES);
}

// ── Choosing what to upload ──────────────────────────────────────────

export interface PlannedAttachment {
  fileName: string;
  file: LocalFile;
  size: number;
  mimeType: SniffedImageType;
}

/** One attachment of a message, as the export describes it. */
export interface AttachmentCandidate {
  fileName: string;
  /** The local copy, when there is one inside the export. */
  file: LocalFile | null;
  size: number | null;
  /** The export only has a link to the platform's servers. */
  remoteOnly?: boolean;
  /** Deleted on the platform (a Slack tombstone). */
  deleted?: boolean;
}

export interface AttachmentCounts {
  /** Images that will be uploaded and linked. */
  linked: number;
  /** Only a link to the platform's servers; never fetched. */
  remoteOnly: number;
  /** Named in the export, but the file is not there (or not inside the export). */
  missing: number;
  /** Not an image of a type the PDS takes (executables, documents, video, SVG…). */
  unsupported: number;
  tooLarge: number;
  /** More than four images on one message. */
  overLimit: number;
  deleted: number;
  /** Local images left out because attachments were turned off (--no-attachments). */
  notUploaded: number;
}

export function emptyAttachmentCounts(): AttachmentCounts {
  return { linked: 0, remoteOnly: 0, missing: 0, unsupported: 0, tooLarge: 0, overLimit: 0, deleted: 0, notUploaded: 0 };
}

export interface AttachmentOptions {
  /** Upload attachments at all (default true). Without it, they are only counted. */
  enabled?: boolean;
  maxBytes?: number;
}

/**
 * Which of a message's attachments to upload, deciding by size and by the
 * file's first bytes. Adds to `counts`.
 */
export function chooseAttachments(
  candidates: AttachmentCandidate[], counts: AttachmentCounts, opts: AttachmentOptions = {},
): PlannedAttachment[] {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES;
  const chosen: PlannedAttachment[] = [];
  for (const c of candidates) {
    if (c.deleted) { counts.deleted++; continue; }
    if (!c.file) { if (c.remoteOnly) counts.remoteOnly++; else counts.missing++; continue; }
    if (opts.enabled === false) { counts.notUploaded++; continue; }
    const size = c.size;
    if (size === null) { counts.missing++; continue; }
    if (size > maxBytes) { counts.tooLarge++; continue; }
    if (size === 0) { counts.unsupported++; continue; }
    let type: SniffedImageType | null = null;
    try {
      type = sniffImageType(readHead(c.file, maxBytes));
    } catch {
      counts.missing++;
      continue;
    }
    if (!type) { counts.unsupported++; continue; }
    if (chosen.length >= MAX_EMBEDS_PER_POST) { counts.overLimit++; continue; }
    chosen.push({ fileName: c.fileName, file: c.file, size, mimeType: type });
    counts.linked++;
  }
  return chosen;
}

/** A link to somewhere else, which is never fetched. */
export function isRemoteUrl(url: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(url);
}
