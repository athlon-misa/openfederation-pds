/**
 * The private export link mailed after a standard takedown (docs/FAIR-USE.md):
 *
 *   GET /takedown-export/:token            the repository as a CAR file
 *   GET /takedown-export/:token/blobs      { cids: [...] } of the repository's blobs
 *   GET /takedown-export/:token/blob/:cid  one blob
 *
 * The token is the only credential: a taken-down account cannot sign in. It
 * works until the deletion date, and never for a hard takedown.
 */
import { Router, type Request, type Response } from 'express';
import { CID } from 'multiformats/cid';
import { query } from '../db/client.js';
import { RepoEngine } from '../repo/repo-engine.js';
import { getBlobStore } from '../blob/blob-store.js';
import { resolveExportToken, markTakedownExported, type TakedownSubject } from './takedown.js';

export const takedownExportRouter = Router();

async function subjectFor(req: Request, res: Response): Promise<TakedownSubject | null> {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  const subject = await resolveExportToken(String(req.params.token || ''));
  if (!subject) res.status(404).json({ error: 'NotFound', message: 'This export link is not valid or has expired' });
  return subject;
}

takedownExportRouter.get('/:token', async (req: Request, res: Response) => {
  try {
    const subject = await subjectFor(req, res);
    if (!subject) return;
    const car = await new RepoEngine(subject.did).exportAsCAR();
    res.setHeader('Content-Type', 'application/vnd.ipld.car');
    res.setHeader('Content-Disposition', `attachment; filename="${subject.did.replace(/[^A-Za-z0-9.-]/g, '_')}.car"`);
    for await (const chunk of car) res.write(chunk);
    res.end();
    await markTakedownExported(subject);
  } catch (err) {
    console.error('[takedown] export failed:', err instanceof Error ? err.message : err);
    if (!res.headersSent) res.status(500).json({ error: 'InternalServerError', message: 'Export failed' });
    else res.end();
  }
});

takedownExportRouter.get('/:token/blobs', async (req: Request, res: Response) => {
  try {
    const subject = await subjectFor(req, res);
    if (!subject) return;
    const rows = await query<{ cid: string }>('SELECT cid FROM blob_owners WHERE did = $1 ORDER BY cid', [subject.did]);
    res.json({ cids: rows.rows.map((r) => r.cid) });
  } catch (err) {
    console.error('[takedown] blob list failed:', err instanceof Error ? err.message : err);
    res.status(500).json({ error: 'InternalServerError', message: 'Could not list blobs' });
  }
});

takedownExportRouter.get('/:token/blob/:cid', async (req: Request, res: Response) => {
  try {
    const subject = await subjectFor(req, res);
    if (!subject) return;
    const cid = String(req.params.cid || '');
    try {
      if (CID.parse(cid).toString() !== cid) throw new Error('non-canonical');
    } catch {
      res.status(404).json({ error: 'BlobNotFound', message: 'Blob not found' });
      return;
    }
    const owned = await query('SELECT 1 FROM blob_owners WHERE cid = $1 AND did = $2', [cid, subject.did]);
    const blob = owned.rows.length ? await (await getBlobStore()).get(cid) : null;
    if (!blob) {
      res.status(404).json({ error: 'BlobNotFound', message: 'Blob not found' });
      return;
    }
    res.setHeader('Content-Type', blob.mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${cid}"`);
    res.send(blob.data);
  } catch (err) {
    console.error('[takedown] blob export failed:', err instanceof Error ? err.message : err);
    res.status(500).json({ error: 'InternalServerError', message: 'Could not fetch blob' });
  }
});
