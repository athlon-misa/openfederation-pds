import crypto from 'crypto';
import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireAuth } from '../auth/guards.js';
import { query } from '../db/client.js';
import { auditLog } from '../db/audit.js';
import { verifyPassword } from '../auth/password.js';
import { buildNextOp, holdsRotationKey, signWithCustodialKey, PlcOpError } from '../identity/plc-ops.js';

/**
 * AT Protocol signPlcOperation (#266): the old PDS signs the user's move
 * with the rotation key it holds in custody. Two checks before signing: the
 * emailed code and the account password. The key is rebuilt from its
 * shares for the signing call and wiped.
 *
 * Only the client can know whether the new PDS already holds the account
 * (that needs the user's session there), so the client checks
 * checkAccountStatus before asking for this signature; this PDS checks that
 * the operation is well formed and keeps the DID usable.
 */
export default async function signPlcOperation(req: AuthRequest, res: Response): Promise<void> {
  if (!requireAuth(req, res)) return;
  if (req.auth.authMethod === 'service-auth') {
    res.status(403).json({ error: 'Forbidden', message: 'Log in to the account to change its identity' });
    return;
  }
  const { token, password, rotationKeys, alsoKnownAs, verificationMethods, services } = req.body ?? {};
  try {
    const user = (await query<{ id: string; auth_type: string; password_hash: string | null }>(
      'SELECT id, auth_type, password_hash FROM users WHERE id = $1', [req.auth.userId])).rows[0];
    if (!user || user.auth_type !== 'local' || !user.password_hash || !(await holdsRotationKey(req.auth.did))) {
      res.status(400).json({ error: 'NotCustodial', message: 'This PDS holds no rotation key for this account' });
      return;
    }
    if (typeof password !== 'string' || !(await verifyPassword(password, user.password_hash))) {
      await auditLog('identity.plcSignature.refused', user.id, user.id, { did: req.auth.did, reason: 'password' });
      res.status(401).json({ error: 'AuthenticationRequired', message: 'Wrong password' });
      return;
    }
    const hash = typeof token === 'string' ? crypto.createHash('sha256').update(token.trim().toUpperCase()).digest('hex') : '';
    const used = await query(
      `UPDATE plc_operation_tokens SET used_at = CURRENT_TIMESTAMP
       WHERE user_id = $1 AND token_hash = $2 AND used_at IS NULL AND expires_at > NOW()`,
      [user.id, hash]);
    if (used.rowCount !== 1) {
      await auditLog('identity.plcSignature.refused', user.id, user.id, { did: req.auth.did, reason: 'token' });
      res.status(400).json({ error: 'InvalidToken', message: 'The code is missing, wrong, used or expired' });
      return;
    }

    const op = await buildNextOp(req.auth.did, { rotationKeys, alsoKnownAs, verificationMethods, services });
    const operation = await signWithCustodialKey(req.auth.did, op);
    await auditLog('identity.plcSignature.signed', user.id, user.id, {
      did: req.auth.did, rotationKeys: op.rotationKeys, endpoint: op.services.atproto_pds.endpoint,
    });
    res.status(200).json({ operation });
  } catch (error) {
    if (error instanceof PlcOpError) {
      res.status(400).json({ error: error.code, message: error.message });
      return;
    }
    console.error('Error in signPlcOperation:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to sign the operation' });
  }
}
