import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireAuth } from '../auth/guards.js';
import { config } from '../config.js';
import { auditLog } from '../db/audit.js';
import { getPlcLog } from '../identity/plc-client.js';
import { cidForPlcOp } from '../../packages/openfederation-pseudonym/src/plc.js';

/**
 * AT Protocol submitPlcOperation (#266): submit a signed operation for the
 * caller's own DID. It must continue the DID's current chain; the directory
 * checks the signature.
 */
export default async function submitPlcOperation(req: AuthRequest, res: Response): Promise<void> {
  if (!requireAuth(req, res)) return;
  if (req.auth.authMethod === 'service-auth') {
    res.status(403).json({ error: 'Forbidden', message: 'Log in to the account to change its identity' });
    return;
  }
  const operation = req.body?.operation as Record<string, unknown> | undefined;
  try {
    if (!operation || typeof operation !== 'object' || operation.type !== 'plc_operation' || typeof operation.sig !== 'string') {
      res.status(400).json({ error: 'InvalidRequest', message: 'operation must be a signed plc_operation' });
      return;
    }
    const log = await getPlcLog(req.auth.did);
    const last = log?.[log.length - 1];
    if (!last || operation.prev !== cidForPlcOp(last)) {
      res.status(400).json({ error: 'InvalidRequest', message: 'The operation does not continue this DID\'s current state' });
      return;
    }
    const plc = await fetch(`${config.plc.directoryUrl}/${req.auth.did}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(operation),
    });
    if (!plc.ok) {
      res.status(400).json({ error: 'PlcRejected', message: `The PLC directory refused the operation (${plc.status})` });
      return;
    }
    await auditLog('identity.plcOperation.submitted', req.auth.userId, req.auth.userId, { did: req.auth.did });
    res.status(200).json({});
  } catch (error) {
    console.error('Error in submitPlcOperation:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to submit the operation' });
  }
}
