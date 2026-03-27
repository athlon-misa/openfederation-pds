import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireApprovedUser } from '../auth/guards.js';
import { RepoEngine } from '../repo/repo-engine.js';
import { getKeypairForDid } from '../repo/keypair-utils.js';
import { auditLog } from '../db/audit.js';
import {
  validatePublicKey,
  validateRkey,
  validatePurpose,
  validateLabel,
  EXTERNAL_KEY_COLLECTION,
} from '../identity/external-keys.js';

export default async function setExternalKey(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireApprovedUser(req, res)) return;

    const { rkey, type, purpose, publicKey, label } = req.body;

    if (!rkey || !type || !purpose || !publicKey) {
      res.status(400).json({
        error: 'InvalidRequest',
        message: 'Missing required fields: rkey, type, purpose, publicKey',
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
