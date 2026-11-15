/**
 * What a blob's bytes say it is (#403).
 *
 * A declared Content-Type is the uploader's word; the first bytes of an image
 * format are not. Only the image types blobs may have are recognised (the
 * list in `config.blob.allowedMimeTypes`); anything else, executables, SVG
 * (which can carry script), archives and documents included, is `null`.
 *
 * Pure and dependency-free, so the `ofc` importer checks a file the same way
 * before uploading it.
 */

export type SniffedImageType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

const startsWith = (buf: Uint8Array, bytes: number[], offset = 0): boolean =>
  buf.length >= offset + bytes.length && bytes.every((b, i) => buf[offset + i] === b);

/** The image type the bytes are, or null when they are not one of the allowed image types. */
export function sniffImageType(buf: Uint8Array): SniffedImageType | null {
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  // GIF87a / GIF89a
  if (startsWith(buf, [0x47, 0x49, 0x46, 0x38]) && (buf[4] === 0x37 || buf[4] === 0x39) && buf[5] === 0x61) return 'image/gif';
  // RIFF....WEBP
  if (startsWith(buf, [0x52, 0x49, 0x46, 0x46]) && startsWith(buf, [0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp';
  return null;
}

/** How many leading bytes `sniffImageType` needs. */
export const SNIFF_BYTES = 16;
