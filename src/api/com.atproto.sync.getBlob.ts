/**
 * com.atproto.sync.getBlob — the ATProto-standard blob read path (#82).
 *
 * Serves raw blob bytes by (did, cid), completing the compliance loop that
 * `com.atproto.repo.uploadBlob` opened: an ATProto client that uploaded a
 * blob and referenced it from a record can fetch it back through the
 * endpoint the spec names, not only through this PDS's `/blob/:did/:cid`
 * convenience route.
 *
 * Deliberately unauthenticated, like upstream — and that is compatible with
 * ADR-001's private-community posture because the CID is the capability. A
 * blob CID is a sha-256 of content nobody can guess; the only place it is
 * published is the record that references it, and records are where the
 * membership gate lives. An outsider cannot learn a private community's
 * avatar CID without first reading the gated profile record. Gating the
 * bytes themselves would instead break every browser <img> tag, which sends
 * no Authorization header.
 */
import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { query } from '../db/client.js';
import { getBlobStore } from '../blob/blob-store.js';
import { CID } from 'multiformats/cid';

export default async function getBlob(req: AuthRequest, res: Response): Promise<void> {
  try {
    const did = String(req.query.did || '');
    const cid = String(req.query.cid || '');
    if (!did || !cid) {
      res.status(400).json({ error: 'InvalidRequest', message: 'did and cid parameters are required' });
      return;
    }

    // Only canonical CIDs reach the store — the same rule the serve route
    // applies, so an alias for a path can never become a storage key.
    try {
      if (CID.parse(cid).toString() !== cid) throw new Error('non-canonical');
    } catch {
      res.status(404).json({ error: 'BlobNotFound', message: 'Blob not found' });
      return;
    }

    // The (did, cid) binding is load-bearing: a blob is fetched from the repo
    // that references it, never as a global content store keyed by hash alone.
    const owned = await query<{ cid: string }>(
      'SELECT cid FROM blob_owners WHERE cid = $1 AND did = $2',
      [cid, did],
    );
    if (owned.rows.length === 0) {
      res.status(404).json({ error: 'BlobNotFound', message: 'Blob not found' });
      return;
    }

    const store = await getBlobStore();
    const blob = await store.get(cid);
    if (!blob) {
      res.status(404).json({ error: 'BlobNotFound', message: 'Blob not found' });
      return;
    }

    res.setHeader('Content-Type', blob.mimeType);
    res.setHeader('Content-Length', blob.data.length.toString());
    // Content-addressed: the bytes for a CID can never change.
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.send(blob.data);
  } catch (error) {
    console.error('Error in sync.getBlob:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'InternalServerError', message: 'Failed to get blob' });
    }
  }
}
