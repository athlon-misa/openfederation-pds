import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireApprovedUser } from '../auth/guards.js';
import { RepoEngine } from '../repo/repo-engine.js';
import { query } from '../db/client.js';
import { getKeypairForDid } from '../repo/keypair-utils.js';
import { fanOutDisplayFields } from '../community/display-projection.js';

const DEFAULT_COLLECTION = 'app.bsky.actor.profile';

export default async function updateProfile(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireApprovedUser(req, res)) return;

    const { displayName, description, avatar, banner, collection, record } = req.body;
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
      if (!displayName && description === undefined && avatar === undefined && banner === undefined) {
        res.status(400).json({
          error: 'InvalidRequest',
          message: 'Provide displayName, description, or a custom collection with record',
        });
        return;
      }

      // Avatar and banner are ATProto blob refs ({$type:'blob', ref:{$link},
      // mimeType, size} — the exact object uploadBlob returned), validated
      // against blob_owners so a profile can only reference blobs its own DID
      // uploaded. `null` removes the image (#82).
      for (const [field, value] of [['avatar', avatar], ['banner', banner]] as const) {
        if (value === undefined || value === null) continue;
        const problem = await validateOwnBlobRef(req.auth!.did, value);
        if (problem) {
          res.status(400).json({ error: 'InvalidBlobRef', message: `${field}: ${problem}` });
          return;
        }
      }

      const existing = await engine.getRecord(DEFAULT_COLLECTION, 'self');
      const current = existing?.record || {};

      finalRecord = {
        ...current,
        ...(displayName !== undefined ? { displayName } : {}),
        ...(description !== undefined ? { description } : {}),
      };
      for (const [field, value] of [['avatar', avatar], ['banner', banner]] as const) {
        if (value === undefined) continue;
        if (value === null) delete (finalRecord as Record<string, unknown>)[field];
        else (finalRecord as Record<string, unknown>)[field] = value;
      }
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

/**
 * Is this a well-formed ATProto blob ref pointing at a blob the caller's own
 * DID uploaded? Returns the problem, or null when it is usable.
 */
async function validateOwnBlobRef(did: string, value: unknown): Promise<string | null> {
  const ref = value as { $type?: string; ref?: { $link?: string }; mimeType?: string };
  const cid = ref?.ref?.$link;
  if (ref?.$type !== 'blob' || typeof cid !== 'string' || typeof ref?.mimeType !== 'string') {
    return 'must be the blob object returned by com.atproto.repo.uploadBlob';
  }
  const owned = await query<{ cid: string }>(
    'SELECT cid FROM blob_owners WHERE cid = $1 AND did = $2', [cid, did],
  );
  return owned.rows.length === 0 ? 'blob not found for this account — upload it first' : null;
}
