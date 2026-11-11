import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { withTransaction } from '../db/client.js';
import { auditLog } from '../db/audit.js';
import { sendEmail } from '../email/email-service.js';
import { custodyChangedEmail } from '../email/templates.js';
import { invalidateAuthContext } from '../auth/auth-context-cache.js';
import { signWithCustodialKey } from '../identity/plc-ops.js';
import { verifyOwnerSignature, type OwnerSignature } from '../identity/owner-signature.js';
import { consumeReservedRotationKey } from './net.openfederation.account.reserveCustodyKey.js';
import {
  CustodyChangeError, heldRotationDidKey, planChange, plcHistory, possessionText, storeRotationKeyShares, unsignedCid, type Plan,
} from '../identity/custody-change.js';
import { authorize, fail, inputsOf, submitToPlc } from '../identity/custody-change-endpoint.js';

/** net.openfederation.identity.finalizeCustodyChange (ADR-003, decision 5). */
export default async function finalizeCustodyChange(req: AuthRequest, res: Response): Promise<void> {
  try {
    const auth = await authorize(req, res);
    if (!auth) return;
    const { account, target } = auth;
    const operationCid = typeof req.body?.operationCid === 'string' ? req.body.operationCid : '';
    if (!operationCid) throw new CustodyChangeError(400, 'InvalidRequest', 'operationCid is required');
    if (account.mode === target) {
      res.status(200).json({ custodyMode: target }); // already done: finalize is idempotent
      return;
    }
    const inputs = inputsOf(req.body);
    const held = await heldRotationDidKey(account.did);
    let history = await plcHistory(account.did);
    const at = history.findIndex((op) => unsignedCid(op) === operationCid);
    let plan: Plan;

    if (at === -1) {
      // Not at PLC yet. Only the PDS-signed direction submits from here.
      plan = planChange(history[history.length - 1], account.mode, target, held, inputs);
      if (plan.signer === 'user') throw new CustodyChangeError(400, 'NotSubmitted', 'Sign the operation with your rotation key and submit it to PLC first');
      if (plan.cid !== operationCid) throw new CustodyChangeError(400, 'OperationMismatch', 'The operation does not match what this change produces now; prepare again');
      const text = possessionText(account.did, operationCid);
      const proof = req.body?.possession as { rotation?: OwnerSignature; owner?: OwnerSignature } | undefined;
      const rotationOk = proof?.rotation && verifyOwnerSignature(text, proof.rotation, inputs.userRotationDidKey!).ok;
      const ownerOk = proof?.owner && verifyOwnerSignature(text, proof.owner, inputs.ownerDidKey!).ok;
      if (!rotationOk || !ownerOk) throw new CustodyChangeError(400, 'PossessionProofInvalid', 'Signatures from both new keys over possessionText are required');
      await submitToPlc(account.did, await signWithCustodialKey(account.did, plan.op));
      history = await plcHistory(account.did);
      if (unsignedCid(history[history.length - 1]) !== plan.cid) throw new CustodyChangeError(502, 'UpstreamFailure', 'PLC does not show the update yet; finalize again');
    } else {
      if (at !== history.length - 1) throw new CustodyChangeError(409, 'StateChanged', 'The DID changed after this operation; prepare again');
      plan = planChange(history[at - 1], account.mode, target, held, inputs);
      if (plan.cid !== operationCid) throw new CustodyChangeError(400, 'OperationMismatch', 'The operation at PLC is not the one this change produces');
    }

    // PLC shows the change: now the database follows.
    await withTransaction(async (client) => {
      if (plan.newPdsKey) {
        const bytes = await consumeReservedRotationKey(client, plan.newPdsKey);
        if (!bytes) throw new CustodyChangeError(409, 'PdsKeyNotReserved', 'This server no longer holds the reserved key; contact the operator');
        await storeRotationKeyShares(client, account.did, bytes);
        bytes.fill(0);
      }
      if (plan.dropShares) await client.query('DELETE FROM vault_shares WHERE user_did = $1', [account.did]);
      await client.query('UPDATE users SET custody_mode = $2 WHERE id = $1', [account.id, target]);
    });
    invalidateAuthContext(account.did);
    await auditLog('identity.custodyChange', account.id, account.id, { did: account.did, from: account.mode, to: target, operationCid });
    if (account.email) {
      await sendEmail(account.email, 'Your account custody changed — OpenFederation',
        custodyChangedEmail(account.handle, account.mode, target), 'other').catch(() => undefined);
    }
    res.status(200).json({ custodyMode: target });
  } catch (error) {
    fail(res, error, 'finalize the custody change');
  }
}
