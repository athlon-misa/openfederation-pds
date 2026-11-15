/**
 * Reading a zip file without unpacking it (#403): enough for a Slack
 * workspace export, which Slack hands out as one `.zip`.
 *
 * The archive is untrusted. Nothing is ever written to disk, so an entry
 * name cannot escape anywhere, but names with `..`, absolute paths or
 * backslashes are still ignored, so a lookup never matches one. Each entry's
 * size is capped before it is inflated (and inflation is told the cap, so a
 * "zip bomb" stops at it), CRCs are checked, and encrypted entries and
 * ZIP64 archives (over 4 GB, or over 65,535 entries) are refused with the
 * advice to unzip it and pass the folder.
 *
 * Only the two methods exports use: stored (0) and deflate (8).
 */
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC-32 as zip uses it (zlib.crc32 only exists from Node 22.2). */
export function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipError';
  }
}

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  crc: number;
  localHeaderOffset: number;
}

export const ZIP_LIMITS = { maxEntries: 200_000, maxEntryBytes: 128 * 1024 * 1024 } as const;

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

/** A name a lookup may match: relative, forward slashes, no `.` or `..` segments. */
export function safeEntryName(name: string): boolean {
  if (!name || name.startsWith('/') || name.includes('\\') || name.includes('\0') || /^[A-Za-z]:/.test(name)) return false;
  return name.split('/').every((seg, i, all) => seg !== '..' && seg !== '.' && (seg !== '' || i === all.length - 1));
}

export class ZipArchive {
  readonly entries = new Map<string, ZipEntry>();
  private fd: number | null;

  private constructor(readonly path: string, fd: number) {
    this.fd = fd;
  }

  static open(path: string): ZipArchive {
    const fd = openSync(path, 'r');
    const zip = new ZipArchive(path, fd);
    try {
      zip.readCentralDirectory();
    } catch (err) {
      zip.close();
      throw err;
    }
    return zip;
  }

  private read(offset: number, length: number): Buffer {
    if (this.fd === null) throw new ZipError(`${this.path}: closed`);
    const buf = Buffer.alloc(length);
    const got = readSync(this.fd, buf, 0, length, offset);
    if (got !== length) throw new ZipError(`${this.path}: truncated`);
    return buf;
  }

  private readCentralDirectory(): void {
    const size = fstatSync(this.fd!).size;
    const tailLength = Math.min(size, 22 + 0xffff);
    if (tailLength < 22) throw new ZipError(`${this.path}: not a zip file`);
    const tail = this.read(size - tailLength, tailLength);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
    }
    if (eocd < 0) throw new ZipError(`${this.path}: not a zip file`);
    const count = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      throw new ZipError(`${this.path}: a ZIP64 archive; unzip it and pass the folder instead`);
    }
    if (count > ZIP_LIMITS.maxEntries) throw new ZipError(`${this.path}: more than ${ZIP_LIMITS.maxEntries} entries`);
    if (cdOffset + cdSize > size) throw new ZipError(`${this.path}: damaged (central directory out of range)`);

    const cd = this.read(cdOffset, cdSize);
    let p = 0;
    for (let i = 0; i < count; i++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== CENTRAL_SIG) throw new ZipError(`${this.path}: damaged central directory`);
      const flags = cd.readUInt16LE(p + 8);
      const method = cd.readUInt16LE(p + 10);
      const crc = cd.readUInt32LE(p + 16);
      const compressedSize = cd.readUInt32LE(p + 20);
      const entrySize = cd.readUInt32LE(p + 24);
      const nameLength = cd.readUInt16LE(p + 28);
      const extraLength = cd.readUInt16LE(p + 30);
      const commentLength = cd.readUInt16LE(p + 32);
      const localHeaderOffset = cd.readUInt32LE(p + 42);
      const name = cd.subarray(p + 46, p + 46 + nameLength).toString(flags & 0x800 ? 'utf8' : 'latin1');
      p += 46 + nameLength + extraLength + commentLength;
      if (compressedSize === 0xffffffff || entrySize === 0xffffffff || localHeaderOffset === 0xffffffff) {
        throw new ZipError(`${this.path}: a ZIP64 archive; unzip it and pass the folder instead`);
      }
      if (name.endsWith('/') || !safeEntryName(name)) continue;
      if (flags & 0x1) throw new ZipError(`${this.path}: ${name} is encrypted`);
      this.entries.set(name, { name, method, compressedSize, size: entrySize, crc, localHeaderOffset });
    }
  }

  /** The entry's bytes, refused when larger than `maxBytes`. */
  readEntry(name: string, maxBytes: number = ZIP_LIMITS.maxEntryBytes): Buffer {
    const entry = this.entries.get(name);
    if (!entry) throw new ZipError(`${this.path}: no entry ${name}`);
    if (entry.size > maxBytes) throw new ZipError(`${this.path}: ${name} is larger than ${maxBytes} bytes`);
    const header = this.read(entry.localHeaderOffset, 30);
    if (header.readUInt32LE(0) !== LOCAL_SIG) throw new ZipError(`${this.path}: ${name}: damaged local header`);
    const dataOffset = entry.localHeaderOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
    const raw = this.read(dataOffset, entry.compressedSize);
    let data: Buffer;
    if (entry.method === 0) data = raw;
    else if (entry.method === 8) {
      try {
        data = inflateRawSync(raw, { maxOutputLength: Math.max(1, entry.size) });
      } catch {
        throw new ZipError(`${this.path}: ${name}: could not be inflated, or is larger than it says`);
      }
    } else throw new ZipError(`${this.path}: ${name}: compression method ${entry.method} is not supported`);
    if (data.length !== entry.size) throw new ZipError(`${this.path}: ${name}: size does not match`);
    if ((crc32(data) >>> 0) !== entry.crc) throw new ZipError(`${this.path}: ${name}: checksum does not match`);
    return data;
  }

  close(): void {
    if (this.fd !== null) closeSync(this.fd);
    this.fd = null;
  }
}
