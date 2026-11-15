import { Response } from 'express';
import { sha256 } from 'multiformats/hashes/sha2';
import { CID } from 'multiformats/cid';
import type { AuthRequest, AuthContext } from '../auth/types.js';
import { requireAuth, requireCommunityRole, requireActiveCommunity } from '../auth/guards.js';
import { config } from '../config.js';
import { query } from '../db/client.js';
import { getBlobStore } from '../blob/blob-store.js';
import { sniffImageType } from '../blob/sniff.js';
import { maxEmbedBytes } from '../forum/import.js';

const RAW_CODEC = 0x55;

/**
 * net.openfederation.forum.importBlob (#403)
 *
 * Upload one attachment of an imported message as a blob of the
 * **community's** repository, for `net.openfederation.forum.importBatch` to
 * link from the post (`embeds`). `com.atproto.repo.uploadBlob` cannot do
 * this: it stores the blob for the caller's own DID, and an imported post is
 * the community's record.
 *
 * Owner (or PDS admin) only, like importBatch. The body is the file's bytes;
 * `Content-Type` must be one of the server's blob types
 * (`config.blob.allowedMimeTypes`, images only) **and** match what the bytes
 * are: a renamed executable, an SVG or a PDF is refused whatever it claims.
 * The size limit is the server's blob limit, capped at the forum.post
 * lexicon's 1,000,000 bytes.
 *
 * Not audited per file: importBatch audits each batch, counts only.
 */
export default async function importBlob(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireAuth(req, res)) return;

    const community = typeof req.query.community === 'string' ? req.query.community : '';
    if (!community.startsWith('did:')) {
      res.status(400).json({ error: 'InvalidRequest', message: 'community must be a DID' });
      return;
    }
    const role = await requireCommunityRole(req as AuthRequest & { auth: AuthContext }, res, community, ['owner']);
    if (!role) return;
    if (!(await requireActiveCommunity(community, res))) return;

    const declared = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (!config.blob.allowedMimeTypes.includes(declared)) {
      res.status(400).json({
        error: 'InvalidMimeType',
        message: `Content-Type must be one of: ${config.blob.allowedMimeTypes.join(', ')}`,
      });
      return;
    }

    const limit = maxEmbedBytes();
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of req) {
      total += chunk.length;
      if (total > limit) {
        res.status(413).json({ error: 'BlobTooLarge', message: `Blob exceeds maximum size of ${limit} bytes` });
        return;
      }
      chunks.push(Buffer.from(chunk));
    }
    const data = Buffer.concat(chunks);
    if (data.length === 0) {
      res.status(400).json({ error: 'InvalidRequest', message: 'Empty blob body' });
      return;
    }

    // The bytes decide, not the header.
    const sniffed = sniffImageType(data);
    if (!sniffed || sniffed !== declared) {
      res.status(400).json({
        error: 'InvalidMimeType',
        message: sniffed
          ? `The file is ${sniffed}, not ${declared}`
          : 'The file is not an image of an allowed type',
      });
      return;
    }

    const cid = CID.create(1, RAW_CODEC, await sha256.digest(data)).toString();
    const store = await getBlobStore();
    await store.put(cid, data, sniffed);
    await query(
      `INSERT INTO blobs (cid, did, mime_type, size) VALUES ($1, $2, $3, $4) ON CONFLICT (cid) DO NOTHING`,
      [cid, community, sniffed, data.length],
    );
    await query(
      `INSERT INTO blob_owners (cid, did) VALUES ($1, $2) ON CONFLICT (cid, did) DO NOTHING`,
      [cid, community],
    );

    // The same bytes may have been stored before; the row is what importBatch checks against.
    const row = (await query<{ mime_type: string; size: number }>('SELECT mime_type, size FROM blobs WHERE cid = $1', [cid])).rows[0];
    res.status(200).json({
      blob: { $type: 'blob', ref: { $link: cid }, mimeType: row?.mime_type ?? sniffed, size: Number(row?.size ?? data.length) },
    });
  } catch (error) {
    console.error('Error in forum.importBlob:', error);
    if (!res.headersSent) res.status(500).json({ error: 'InternalServerError', message: 'Failed to upload blob' });
  }
}
