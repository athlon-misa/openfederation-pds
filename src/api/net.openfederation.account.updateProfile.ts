import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireApprovedUser } from '../auth/guards.js';
import { RepoEngine } from '../repo/repo-engine.js';
import { getKeypairForDid } from '../repo/keypair-utils.js';
import { fanOutDisplayFields } from '../community/display-projection.js';

const DEFAULT_COLLECTION = 'app.bsky.actor.profile';

export default async function updateProfile(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireApprovedUser(req, res)) return;

    const { displayName, description, collection, record } = req.body;
    const did = req.auth!.did;
    const targetCollection = collection || DEFAULT_COLLECTION;

    if (collection && !/^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*){2,}$/.test(collection)) {
      res.status(400).json({
        error: 'InvalidRequest',
        message: 'collection must be a valid NSID (e.g., app.grvty.actor.profile)',
      });
      return;
    }

    const engine = new RepoEngine(did);
    const keypair = await getKeypairForDid(did);

    let finalRecord: Record<string, unknown>;

    if (collection && record) {
      if (typeof record !== 'object' || record === null || Array.isArray(record)) {
        res.status(400).json({
          error: 'InvalidRequest',
          message: 'record must be a JSON object',
        });
        return;
      }
      finalRecord = record;
    } else {
      if (!displayName && description === undefined) {
        res.status(400).json({
          error: 'InvalidRequest',
          message: 'Provide displayName, description, or a custom collection with record',
        });
        return;
      }

      const existing = await engine.getRecord(DEFAULT_COLLECTION, 'self');
      const current = existing?.record || {};

      finalRecord = {
        ...current,
        ...(displayName !== undefined ? { displayName } : {}),
        ...(description !== undefined ? { description } : {}),
      };
    }

    const result = await engine.putRecord(keypair, targetCollection, 'self', finalRecord);

    // Fan out updated display fields to every community this user belongs to
    await fanOutDisplayFields(did, req.auth!.handle);

    res.status(200).json({ uri: result.uri, cid: result.cid });
  } catch (error) {
    console.error('Error in updateProfile:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to update profile' });
  }
}
