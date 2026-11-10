import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireAuth } from '../auth/guards.js';
import { getConsentRequest } from '../wallet/index.js';

/**
 * GET net.openfederation.wallet.getConsentRequest: where a consent request
 * stands, for the dApp that made it to poll after sending the user to the
 * approval page. Only the account the request is for can read it.
 */
export default async function walletGetConsentRequest(req: AuthRequest, res: Response): Promise<void> {
  if (!requireAuth(req, res)) return;
  const requestId = String(req.query.requestId || '');
  const request = await getConsentRequest(requestId);
  if (!request || request.userDid !== req.auth!.did) {
    res.status(404).json({ error: 'NotFound', message: 'No such consent request' });
    return;
  }
  res.status(200).json({
    requestId: request.id,
    status: request.status === 'pending' && request.expired ? 'expired' : request.status,
    dappOrigin: request.dappOrigin,
    expiresAt: request.expiresAt,
    ...(request.consentId ? { consentId: request.consentId } : {}),
  });
}
