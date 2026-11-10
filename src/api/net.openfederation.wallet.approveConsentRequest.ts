import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { config } from '../config.js';
import { query } from '../db/client.js';
import { auditLog } from '../db/audit.js';
import { checkPasswordWithLockout } from '../auth/password-check.js';
import { getConsentRequest, settleConsentRequest, ConsentRequestError } from '../wallet/index.js';

/**
 * POST net.openfederation.wallet.approveConsentRequest
 *
 * Called by the approval page this PDS serves, never by a dApp. It needs no
 * session: what proves the user is present is their password, checked with
 * the same lockout as login. The request must come from the PDS's own
 * origin, so a dApp's script cannot submit it even if it learned the
 * request id (which it did: it made the request).
 */
export default async function walletApproveConsentRequest(req: AuthRequest, res: Response): Promise<void> {
  try {
    const pdsOrigin = new URL(config.pds.serviceUrl).origin;
    if (req.headers.origin !== pdsOrigin) {
      res.status(403).json({ error: 'Forbidden', message: 'Consent can only be approved on this server\'s own approval page' });
      return;
    }
    const { requestId, password, approve } = req.body ?? {};
    if (typeof requestId !== 'string' || typeof approve !== 'boolean') {
      res.status(400).json({ error: 'InvalidRequest', message: 'requestId and approve (boolean) are required' });
      return;
    }
    const request = await getConsentRequest(requestId);
    if (!request) {
      res.status(404).json({ error: 'NotFound', message: 'No such consent request' });
      return;
    }

    if (approve) {
      const user = (await query<{ id: string; password_hash: string | null }>(
        'SELECT id, password_hash FROM users WHERE did = $1', [request.userDid])).rows[0];
      if (!user?.password_hash) {
        res.status(400).json({ error: 'InvalidRequest', message: 'This account has no password to approve with' });
        return;
      }
      const check = await checkPasswordWithLockout(user.id, user.password_hash, typeof password === 'string' ? password : '');
      if (!check.ok) {
        res.status(check.reason === 'locked' ? 429 : 401).json(check.reason === 'locked'
          ? { error: 'AccountLocked', message: `Too many failed attempts. Try again in ${check.retryAfterSeconds} seconds.` }
          : { error: 'InvalidPassword', message: 'Password is incorrect' });
        return;
      }
    }

    const { request: settled, consent } = await settleConsentRequest(requestId, approve);
    await auditLog(approve ? 'wallet.consent.grant' : 'wallet.consent.deny', null, settled.userDid, {
      requestId,
      dappOrigin: settled.dappOrigin,
      chain: settled.chain,
      walletAddress: settled.walletAddress,
      ...(consent ? { consentId: consent.id, expiresAt: consent.expiresAt, allowedContracts: consent.allowedContracts } : {}),
    });
    res.status(200).json({ status: settled.status, ...(consent ? { consentId: consent.id, expiresAt: consent.expiresAt } : {}) });
  } catch (err) {
    if (err instanceof ConsentRequestError) {
      res.status(err.status).json({ error: err.code, message: err.message });
      return;
    }
    console.error('Error in walletApproveConsentRequest:', err);
    if (!res.headersSent) res.status(500).json({ error: 'InternalServerError', message: 'Failed to settle consent request' });
  }
}
