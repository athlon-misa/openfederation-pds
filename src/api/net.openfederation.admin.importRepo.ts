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

    // Collect raw CAR body
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
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

    // Store all blocks in repo_blocks
    let blockCount = 0;
    const blockEntries = blocks.entries();
    for (const entry of blockEntries) {
      const cid = entry.cid.toString();
      const bytes = entry.bytes;
      await query(
        `INSERT INTO repo_blocks (did, cid, block_data)
         VALUES ($1, $2, $3)
         ON CONFLICT (did, cid) DO NOTHING`,
        [did, cid, Buffer.from(bytes)]
      );
      blockCount++;
    }

    // Register repo root
    await query(
      `INSERT INTO repo_roots (did, root_cid, rev)
       VALUES ($1, $2, $3)
       ON CONFLICT (did) DO UPDATE SET root_cid = $2, rev = $3`,
      [did, rootCidStr, rootCidStr.slice(-10)]
    );

    // Walk the MST to populate records_index
    const { RepoEngine } = await import('../repo/repo-engine.js');
    const engine = new RepoEngine(did);
    const records = await engine.exportAllRecords();

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
