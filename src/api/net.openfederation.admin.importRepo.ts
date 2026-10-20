import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireRole } from '../auth/guards.js';
import { query } from '../db/client.js';
import { auditLog } from '../db/audit.js';

export default async function importRepo(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireRole(req, res, ['admin'])) return;

    const did = req.query.did as string;

    if (!did || !did.startsWith('did:')) {
      res.status(400).json({
        error: 'InvalidRequest',
        message: 'did query parameter is required and must be a valid DID',
      });
      return;
    }

    // Check repo doesn't already exist
    const existingRepo = await query(
      'SELECT 1 FROM repo_roots WHERE did = $1',
      [did]
    );

    if (existingRepo.rows.length > 0) {
      res.status(409).json({
        error: 'RepoAlreadyExists',
        message: `A repository already exists for DID: ${did}`,
      });
      return;
    }

    // Collect raw CAR body (100 MB hard limit to prevent DoS via memory exhaustion)
    const MAX_CAR_SIZE = 100 * 1024 * 1024;
    const chunks: Buffer[] = [];
    let totalSize = 0;
    for await (const chunk of req) {
      totalSize += chunk.length;
      if (totalSize > MAX_CAR_SIZE) {
        res.status(413).json({
          error: 'PayloadTooLarge',
          message: 'CAR body exceeds maximum size of 100 MB',
        });
        return;
      }
      chunks.push(Buffer.from(chunk));
    }
    const carBytes = Buffer.concat(chunks);

    if (carBytes.length === 0) {
      res.status(400).json({
        error: 'InvalidRequest',
        message: 'Empty CAR body',
      });
      return;
    }

    // Parse CAR using @atproto/repo
    let root: any;
    let blocks: any;
    try {
      const { readCarWithRoot } = await import('@atproto/repo');
      const result = await readCarWithRoot(new Uint8Array(carBytes));
      root = result.root;
      blocks = result.blocks;
    } catch (err) {
      res.status(400).json({
        error: 'InvalidCar',
        message: 'Failed to parse CAR data',
      });
      return;
    }

    const rootCidStr = root.toString();

    // The commit names the repo's DID and revision. Refuse a backup that
    // belongs to another DID: importing it would serve someone else's
    // signed data under this DID.
    let rev: string;
    try {
      const { cborDecode } = await import('@atproto/common');
      const commitBytes = blocks.get(root);
      const commit = commitBytes ? cborDecode(commitBytes) as { did?: unknown; rev?: unknown } : null;
      if (!commit || typeof commit.did !== 'string' || typeof commit.rev !== 'string') throw new Error('no commit');
      if (commit.did !== did) {
        res.status(400).json({ error: 'DidMismatch', message: 'The CAR\'s commit belongs to a different DID' });
        return;
      }
      rev = commit.rev;
    } catch {
      res.status(400).json({ error: 'InvalidCar', message: 'CAR root is not a repository commit' });
      return;
    }

    // Store all blocks in repo_blocks
    let blockCount = 0;
    const blockEntries = blocks.entries();
    for (const entry of blockEntries) {
      const cid = entry.cid.toString();
      const bytes = entry.bytes;
      await query(
        `INSERT INTO repo_blocks (community_did, cid, block_bytes, rev)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (community_did, cid) DO NOTHING`,
        [did, cid, Buffer.from(bytes), rev]
      );
      blockCount++;
    }

    // Register repo root
    await query(
      `INSERT INTO repo_roots (did, root_cid, rev)
       VALUES ($1, $2, $3)
       ON CONFLICT (did) DO UPDATE SET root_cid = $2, rev = $3`,
      [did, rootCidStr, rev]
    );

    // Walk the imported MST to populate records_index. (records_index is
    // empty for this DID, so it cannot be its own source.)
    const { Repo } = await import('@atproto/repo');
    const { PgBlockstore } = await import('../repo/pg-blockstore.js');
    const repo = await Repo.load(new PgBlockstore(did), root);
    const records: { collection: string; rkey: string; cid: string; record: unknown }[] = [];
    for await (const r of repo.walkRecords()) {
      records.push({ collection: r.collection, rkey: r.rkey, cid: r.cid.toString(), record: r.record });
    }

    let recordCount = 0;
    for (const record of records) {
      await query(
        `INSERT INTO records_index (community_did, collection, rkey, record, cid)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (community_did, collection, rkey) DO UPDATE SET record = $4, cid = $5`,
        [did, record.collection, record.rkey, JSON.stringify(record.record), record.cid || '']
      );
      recordCount++;
    }

    await auditLog('admin.importRepo', req.auth!.userId, did, {
      rootCid: rootCidStr,
      blockCount,
      recordCount,
    });

    res.status(200).json({
      did,
      rootCid: rootCidStr,
      blockCount,
      recordCount,
    });
  } catch (error) {
    console.error('Error in importRepo:', error);
    res.status(500).json({
      error: 'InternalServerError',
      message: 'Failed to import repository',
    });
  }
}
