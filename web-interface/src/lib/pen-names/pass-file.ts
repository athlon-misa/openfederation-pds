/**
 * Passes outside the browser that collected them: a small JSON file, or one
 * pass as text (printed next to its QR code). Pure functions, no network, so
 * the format can be tested on its own.
 *
 * A pass is a blind creation token: the server signed it without seeing it,
 * so it carries nothing about the account that collected it. It is valid on
 * the server that signed it, for the month it was collected and the month
 * after (the server keeps two monthly keys); then that key is retired.
 *
 * The file and the text also name the account the passes were collected by
 * (`owner`): a new pen name seals that account's DID into its public entry
 * (hidden, opened only by a proof), so it can later be proven yours. The
 * server never sees the file.
 */
import { sha256 } from '@noble/hashes/sha2';

export interface Pass {
  /** The month the pass was collected in, YYYY-MM (UTC). */
  epoch: string;
  prepared: string;
  signature: string;
  /** Fingerprint of the server's published key for that month, when known. */
  key?: string;
}

export const PASS_FILE_FORMAT = 'openfederation-pen-name-passes';
export const PASS_FILE_VERSION = 1;
export const PASS_TEXT_PREFIX = 'ofpass1';

export interface PassFile {
  format: typeof PASS_FILE_FORMAT;
  version: number;
  /** The server that signed the passes; they work there only. */
  server: string;
  /** The account that collected them: new pen names are sealed to it. */
  owner: string;
  savedAt: string;
  warning: string;
  passes: (Pass & { expires: string })[];
}

export type PassFileProblem =
  | 'NotPassFile' | 'NewerVersion' | 'OtherServer' | 'Damaged' | 'Checksum' | 'AllExpired';

export class PassFileError extends Error {
  constructor(readonly problem: PassFileProblem, message: string) { super(message); this.name = 'PassFileError'; }
}

const B64URL = /^[A-Za-z0-9_-]+$/;
const EPOCH = /^\d{4}-(0[1-9]|1[0-2])$/;
const DID = /^did:[a-z]+:[A-Za-z0-9._:%-]+$/;

const trimUrl = (u: string) => u.trim().replace(/\/+$/, '');
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const sha256Hex = (s: string) => hex(sha256(new TextEncoder().encode(s)));

export function epochOf(now: Date = new Date()): string {
  return now.toISOString().slice(0, 7);
}

/** When a pass from `epoch` stops working: the first moment of the month after next (UTC). */
export function passExpiry(epoch: string): Date {
  const [y, m] = epoch.split('-').map(Number);
  // `m` is 1-based, Date.UTC's month 0-based: index m is the month after, m + 1 the one after that.
  return new Date(Date.UTC(y, m + 1, 1));
}

export function isExpired(pass: Pick<Pass, 'epoch'>, now: Date = new Date()): boolean {
  return now.getTime() >= passExpiry(pass.epoch).getTime();
}

/** A fingerprint of a published month key (its SPKI, base64url), to put next to the passes it signed. */
export function keyFingerprint(spkiB64: string): string {
  return sha256Hex(spkiB64).slice(0, 16);
}

/** A short, stable name for one pass, to find it again (remove it, spot a duplicate). */
export function passId(pass: Pick<Pass, 'signature'>): string {
  return sha256Hex(pass.signature).slice(0, 12);
}

function validPass(p: unknown): p is Pass {
  const x = p as Partial<Pass> | null;
  return !!x && typeof x.epoch === 'string' && EPOCH.test(x.epoch)
    && typeof x.prepared === 'string' && B64URL.test(x.prepared)
    && typeof x.signature === 'string' && B64URL.test(x.signature)
    && (x.key === undefined || (typeof x.key === 'string' && /^[0-9a-f]{16}$/.test(x.key)));
}

export const PASS_FILE_WARNING = 'Anyone who has this file can create pen names on this server with these passes. They cannot link those pen names to you.';

export function buildPassFile(p: { server: string; owner: string; passes: Pass[]; now?: Date }): PassFile {
  const now = p.now ?? new Date();
  return {
    format: PASS_FILE_FORMAT,
    version: PASS_FILE_VERSION,
    server: trimUrl(p.server),
    owner: p.owner,
    savedAt: now.toISOString(),
    warning: PASS_FILE_WARNING,
    passes: p.passes.filter((x) => !isExpired(x, now)).map((x) => ({
      epoch: x.epoch, ...(x.key ? { key: x.key } : {}), expires: passExpiry(x.epoch).toISOString(),
      prepared: x.prepared, signature: x.signature,
    })),
  };
}

export interface LoadedPasses {
  server: string;
  owner: string;
  /** Usable passes, duplicates removed. */
  passes: Pass[];
  /** How many were left out because their month key is retired. */
  expired: number;
}

function finish(server: string, owner: string, all: Pass[], now: Date): LoadedPasses {
  const seen = new Set<string>();
  const passes: Pass[] = [];
  let expired = 0;
  for (const x of all) {
    if (isExpired(x, now)) { expired++; continue; }
    const id = passId(x);
    if (seen.has(id)) continue;
    seen.add(id);
    passes.push({ epoch: x.epoch, prepared: x.prepared, signature: x.signature, ...(x.key ? { key: x.key } : {}) });
  }
  if (!passes.length && expired) {
    throw new PassFileError('AllExpired', `Every pass here has expired (the last ones were valid until ${passExpiry(all[all.length - 1].epoch).toISOString().slice(0, 10)}). Collect new ones: they are collected automatically when you sign in to your account.`);
  }
  return { server, owner, passes, expired };
}

function checkServer(server: string, expected: string): void {
  if (trimUrl(server) !== trimUrl(expected)) {
    throw new PassFileError('OtherServer', `These passes were signed by ${trimUrl(server)}. They only work there, not on ${trimUrl(expected)}.`);
  }
}

/** Read a saved pass file. Refuses another server's passes, a newer format, or a damaged file. */
export function parsePassFile(text: string, opts: { server: string; now?: Date }): LoadedPasses {
  let json: Partial<PassFile>;
  try { json = JSON.parse(text) as Partial<PassFile>; } catch { throw new PassFileError('NotPassFile', 'This is not a pass file (it is not JSON).'); }
  if (!json || json.format !== PASS_FILE_FORMAT) throw new PassFileError('NotPassFile', 'This is not a pass file.');
  if (typeof json.version !== 'number' || json.version > PASS_FILE_VERSION) {
    throw new PassFileError('NewerVersion', 'This pass file was saved by a newer version of the dashboard. Open it there, or update this one.');
  }
  if (typeof json.server !== 'string' || typeof json.owner !== 'string' || !DID.test(json.owner) || !Array.isArray(json.passes) || !json.passes.every(validPass)) {
    throw new PassFileError('Damaged', 'This pass file is damaged: something in it is missing or changed.');
  }
  checkServer(json.server, opts.server);
  return finish(trimUrl(json.server), json.owner, json.passes, opts.now ?? new Date());
}

function checksum(body: string): string {
  return sha256Hex(body).slice(0, 8);
}

/**
 * One pass as text: `ofpass1~server~owner~month~prepared~signature~checksum`.
 * About 500 characters; the QR code is its practical paper form. The checksum
 * catches a mistyped or cut-off copy.
 */
export function passToText(pass: Pass, p: { server: string; owner: string }): string {
  const body = [PASS_TEXT_PREFIX, trimUrl(p.server), p.owner, pass.epoch, pass.prepared, pass.signature].join('~');
  return `${body}~${checksum(body)}`;
}

/** The text in groups of eight, for reading off paper. Whitespace is ignored when it is read back. */
export function groupText(text: string, size = 8): string {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out.join(' ');
}

/** Read one or more passes from pasted or scanned text (one per line, or run together). */
export function parsePassText(text: string, opts: { server: string; now?: Date }): LoadedPasses {
  const codes = text.replace(/\s+/g, '').split(new RegExp(`(?=${PASS_TEXT_PREFIX}~)`)).filter(Boolean);
  if (!codes.length) throw new PassFileError('NotPassFile', 'Paste a pass: it starts with “ofpass1~”.');
  let server = '';
  let owner = '';
  const passes: Pass[] = [];
  for (const code of codes) {
    const parts = code.split('~');
    if (parts[0] !== PASS_TEXT_PREFIX) throw new PassFileError('NotPassFile', 'This is not a pass: a pass starts with “ofpass1~”.');
    if (parts.length !== 7) throw new PassFileError('Damaged', 'This pass is incomplete: part of it is missing. Check you copied all of it.');
    const [, s, o, epoch, prepared, signature, sum] = parts;
    if (checksum(parts.slice(0, 6).join('~')) !== sum.toLowerCase()) {
      throw new PassFileError('Checksum', 'This pass does not match its checksum: a character is wrong or missing. Check it against the paper, or load the file instead.');
    }
    const pass = { epoch, prepared, signature };
    if (!DID.test(o) || !validPass(pass)) throw new PassFileError('Damaged', 'This pass is damaged.');
    checkServer(s, opts.server);
    if (owner && o !== owner) throw new PassFileError('Damaged', 'These passes were collected by different accounts. Load one account’s passes at a time.');
    server = trimUrl(s); owner = o;
    passes.push(pass);
  }
  return finish(server, owner, passes, opts.now ?? new Date());
}

/** Read whatever was loaded: a pass file, or pass text. */
export function parsePasses(text: string, opts: { server: string; now?: Date }): LoadedPasses {
  return text.trim().startsWith('{') ? parsePassFile(text, opts) : parsePassText(text, opts);
}
