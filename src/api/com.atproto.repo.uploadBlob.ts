import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireApprovedUser } from '../auth/guards.js';
import { enforcePseudonymProbation } from '../auth/pseudonym-probation.js';
import { config } from '../config.js';
import { query } from '../db/client.js';
import { getBlobStore } from '../blob/blob-store.js';
import { sha256 } from 'multiformats/hashes/sha2';
import { CID } from 'multiformats/cid';

// Raw codec for blobs (not CBOR)
const RAW_CODEC = 0x55;

/** A deactivated account copying its blobs in (#264, #265); it cannot write records. */
function isDeactivated(req: AuthRequest): boolean {
  return !!req.auth && req.auth.authMethod !== 'service-auth' && req.auth.status === 'deactivated';
}

export default async function uploadBlob(req: AuthRequest, res: Response): Promise<void> {
  try {
    // An account moving here uploads its blobs before it is activated (#264).
    const migrating = isDeactivated(req);
    if (!migrating && !requireApprovedUser(req, res)) return;

    const contentType = req.headers['content-type'];

    if (!contentType || !config.blob.allowedMimeTypes.includes(contentType)) {
      res.status(400).json({
        error: 'InvalidMimeType',
        message: `Content-Type must be one of: ${config.blob.allowedMimeTypes.join(', ')}`,
      });
      return;
    }

    // Collect raw body
    const chunks: Buffer[] = [];
    let totalSize = 0;

    for await (const chunk of req) {
      totalSize += chunk.length;
      if (totalSize > config.blob.maxSize) {
        res.status(413).json({
          error: 'BlobTooLarge',
          message: `Blob exceeds maximum size of ${config.blob.maxSize} bytes`,
        });
        return;
      }
      chunks.push(Buffer.from(chunk));
    }

    const data = Buffer.concat(chunks);

    if (data.length === 0) {
      res.status(400).json({
        error: 'InvalidRequest',
        message: 'Empty blob body',
      });
      return;
    }

    // Copying existing blobs during a move is not new writing.
    if (!migrating && !(await enforcePseudonymProbation(req, res))) return;

    // Compute CID: v1, raw codec, sha256
    const hash = await sha256.digest(data);
    const cid = CID.create(1, RAW_CODEC, hash);
    const cidStr = cid.toString();

    // Store blob
    const store = await getBlobStore();
    await store.put(cidStr, data, contentType);

    // Store metadata in database
    await query(
      `INSERT INTO blobs (cid, did, mime_type, size)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (cid) DO NOTHING`,
      [cidStr, req.auth!.did, contentType, data.length]
    );
    await query(
      `INSERT INTO blob_owners (cid, did)
       VALUES ($1, $2)
       ON CONFLICT (cid, did) DO NOTHING`,
      [cidStr, req.auth!.did],
    );

    res.status(200).json({
      blob: {
        $type: 'blob',
        ref: { $link: cidStr },
        mimeType: contentType,
        size: data.length,
      },
    });
  } catch (error) {
    console.error('Error in uploadBlob:', error);
    res.status(500).json({
      error: 'InternalServerError',
      message: 'Failed to upload blob',
    });
  }
}
