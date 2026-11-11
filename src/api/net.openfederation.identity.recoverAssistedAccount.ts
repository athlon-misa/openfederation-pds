import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireAuth, requireApprovedUser, requireLocalAccount } from '../auth/guards.js';
import { query } from '../db/client.js';
import { config } from '../config.js';
import { auditLog } from '../db/audit.js';
import { checkPasswordWithLockout } from '../auth/password-check.js';
import { buildNextOp, signWithCustodialKey } from '../identity/plc-ops.js';
import { verifyOwnerSignature, type OwnerSignature } from '../identity/owner-signature.js';
import { CustodyChangeError, heldRotationDidKey, plcHistory, possessionText, unsignedCid } from '../identity/custody-change.js';
import { noticeServerSignedUpdate } from '../identity/assisted-notice.js';

const SECP256K1_DID_KEY = /^did:key:zQ3s[1-9A-HJ-NP-Za-km-z]+$/;
const OWNER_DID_KEY = /^did:key:z(Q3s|Dn)[1-9A-HJ-NP-Za-km-z]+$/;

/**
 * net.openfederation.identity.recoverAssistedAccount (ADR-003, decision 10)
 *
 * An `assisted` account whose phrase is lost. With an identity verification
 * from the last 30 minutes (admin.createVerificationChallenge →
 * admin.verifyChallenge; each verification allows one recovery), the
 * password, and proof that the person holds the new keys, this server signs
 * with its second-priority key an update that puts the new keys first. The
 * old key can cancel it for 72 hours (PLC nullification), so a recovery
 * started by someone else fails while the real person still has their
 * phrase; the account is emailed about it.
 *
 * Without operationCid the call only plans: it returns the update and the
 * text to sign with both new keys.
 */
export default async function recoverAssistedAccount(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireAuth(req, res) || !requireLocalAccount(req, res) || !requireApprovedUser(req, res)) return;
    const did = req.auth.did;
    const user = (await query<{ id: string; password_hash: string | null; custody_mode: string | null }>(
      'SELECT id, password_hash, custody_mode FROM users WHERE did = $1', [did])).rows[0];
    if (!user || user.custody_mode !== 'assisted') throw new CustodyChangeError(400, 'NotAssisted', 'Only assisted accounts are recovered this way');

    const verified = (await query<{ created_at: Date }>(
      `SELECT created_at FROM audit_log WHERE target_id = $1 AND action = 'admin.verification.success'
       AND created_at > NOW() - INTERVAL '30 minutes' ORDER BY created_at DESC LIMIT 1`, [user.id])).rows[0];
    const used = verified && (await query(
      `SELECT 1 FROM audit_log WHERE target_id = $1 AND action = 'identity.assistedRecovery' AND created_at >= $2 LIMIT 1`,
      [user.id, verified.created_at])).rows.length > 0;
    if (!verified || used) throw new CustodyChangeError(403, 'VerificationRequired', 'A fresh identity verification is required for each recovery (admin.createVerificationChallenge, admin.verifyChallenge)');

    const check = user.password_hash
      ? await checkPasswordWithLockout(user.id, user.password_hash, typeof req.body?.password === 'string' ? req.body.password : '')
      : { ok: false as const, reason: 'wrong' as const };
    if (!check.ok) {
      if (check.reason === 'locked') throw new CustodyChangeError(429, 'AccountLocked', 'Too many failed attempts; try again later');
      throw new CustodyChangeError(401, 'InvalidPassword', 'Password is incorrect');
    }

    const newRotation = req.body?.userRotationDidKey;
    const newOwner = req.body?.ownerDidKey;
    if (typeof newRotation !== 'string' || !SECP256K1_DID_KEY.test(newRotation)) throw new CustodyChangeError(400, 'InvalidRequest', 'userRotationDidKey (secp256k1 did:key) is required');
    if (typeof newOwner !== 'string' || !OWNER_DID_KEY.test(newOwner)) throw new CustodyChangeError(400, 'InvalidRequest', 'ownerDidKey (secp256k1 or P-256 did:key) is required');
    const held = await heldRotationDidKey(did);
    if (!held) throw new CustodyChangeError(409, 'NotCustodial', 'This server holds no backup key for the account');

    const history = await plcHistory(did);
    const current = history[history.length - 1];
    const op = await buildNextOp(did, {
      rotationKeys: [newRotation, held],
      verificationMethods: { ...current.verificationMethods, openfederation_owner: newOwner },
    });
    const operationCid = unsignedCid(op);
    const text = possessionText(did, operationCid);

    if (typeof req.body?.operationCid !== 'string') {
      res.status(200).json({ operation: op, operationCid, possessionText: text });
      return;
    }
    if (req.body.operationCid !== operationCid) throw new CustodyChangeError(400, 'OperationMismatch', 'The DID changed since the plan; plan again');
    const proof = req.body?.possession as { rotation?: OwnerSignature; owner?: OwnerSignature } | undefined;
    if (!(proof?.rotation && verifyOwnerSignature(text, proof.rotation, newRotation).ok && proof.owner && verifyOwnerSignature(text, proof.owner, newOwner).ok)) {
      throw new CustodyChangeError(400, 'PossessionProofInvalid', 'Signatures from both new keys over possessionText are required');
    }

    const signed = await signWithCustodialKey(did, op);
    const plc = await fetch(`${config.plc.directoryUrl}/${did}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(signed) });
    if (!plc.ok) throw new CustodyChangeError(502, 'UpstreamFailure', `The PLC directory refused the update (${plc.status})`);
    const after = await plcHistory(did);
    if (unsignedCid(after[after.length - 1]) !== operationCid) throw new CustodyChangeError(502, 'UpstreamFailure', 'PLC does not show the update yet');

    await auditLog('identity.assistedRecovery', user.id, user.id, { did, operationCid, newRotationKey: newRotation });
    const cancelUntil = await noticeServerSignedUpdate(did, operationCid, 'an account recovery after an identity verification');
    res.status(200).json({ operationCid, cancelUntil: cancelUntil.toISOString() });
  } catch (error) {
    if (error instanceof CustodyChangeError) {
      res.status(error.status).json({ error: error.code, message: error.message });
      return;
    }
    console.error('Error in recoverAssistedAccount:', error instanceof Error ? error.message : error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to recover the account' });
  }
}
