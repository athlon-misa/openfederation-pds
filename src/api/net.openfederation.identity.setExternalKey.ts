import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireApprovedUser } from '../auth/guards.js';
import { RepoEngine } from '../repo/repo-engine.js';
import { getKeypairForDid } from '../repo/keypair-utils.js';
import { auditLog } from '../db/audit.js';
import { query } from '../db/client.js';
import {
  validatePublicKey,
  validateRkey,
  validatePurpose,
  validateLabel,
  verifyExternalKeyProof,
  EXTERNAL_KEY_COLLECTION,
} from '../identity/external-keys.js';

export default async function setExternalKey(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireApprovedUser(req, res)) return;

    const { rkey, type, purpose, publicKey, proof, label } = req.body;

    if (!rkey || !type || !purpose || !publicKey || !proof) {
      res.status(400).json({
        error: 'InvalidRequest',
        message: 'Missing required fields: rkey, type, purpose, publicKey, proof',
      });
      return;
    }

    const rkeyResult = validateRkey(rkey);
    if (rkeyResult.valid === false) {
      res.status(400).json({ error: 'InvalidRequest', message: rkeyResult.error });
      return;
    }

    const purposeResult = validatePurpose(purpose);
    if (purposeResult.valid === false) {
      res.status(400).json({ error: 'InvalidRequest', message: purposeResult.error });
      return;
    }

    const labelResult = validateLabel(label);
    if (labelResult.valid === false) {
      res.status(400).json({ error: 'InvalidRequest', message: labelResult.error });
      return;
    }

    const keyResult = validatePublicKey(publicKey, type);
    if (keyResult.valid === false) {
      res.status(400).json({ error: 'InvalidPublicKey', message: keyResult.error });
      return;
    }

    const did = req.auth!.did;
    const proofResult = verifyExternalKeyProof(did, rkey, type, purpose, publicKey, proof);
    if (proofResult.valid === false) {
      res.status(400).json({ error: 'InvalidProof', message: proofResult.error });
      return;
    }

    const existingClaim = await query<{ community_did: string; rkey: string }>(
      `SELECT community_did, rkey FROM records_index
       WHERE collection = $1 AND record->>'publicKey' = $2
         AND (community_did <> $3 OR rkey <> $4)
       LIMIT 1`,
      [EXTERNAL_KEY_COLLECTION, publicKey, did, rkey],
    );
    if (existingClaim.rows.length > 0) {
      res.status(409).json({
        error: 'KeyAlreadyClaimed',
        message: 'This public key is already claimed by another external-key record',
      });
      return;
    }

    const engine = new RepoEngine(did);
    const keypair = await getKeypairForDid(did);

    const record = {
      type,
      purpose,
      publicKey,
      ...(label ? { label } : {}),
      createdAt: new Date().toISOString(),
    };

    const result = await engine.putRecord(keypair, EXTERNAL_KEY_COLLECTION, rkey, record);

    await auditLog('identity.setExternalKey', req.auth!.userId, did, {
      rkey,
      type,
      purpose,
    });

    res.status(200).json({
      uri: result.uri,
      cid: result.cid,
    });
  } catch (error) {
    console.error('Error in setExternalKey:', error);
    res.status(500).json({
      error: 'InternalServerError',
      message: 'Failed to set external key',
    });
  }
}
