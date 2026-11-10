import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireAuth } from '../auth/guards.js';

/**
 * POST net.openfederation.wallet.grantConsent: no longer grants anything.
 *
 * It let any script holding the user's session token give itself permission
 * to have custodial wallets sign, without the user ever seeing it. A dApp
 * now calls `wallet.requestConsent` and sends the user to the page it
 * returns; the consent exists once the user approves it there.
 */
export default async function walletGrantConsent(req: AuthRequest, res: Response): Promise<void> {
  if (!requireAuth(req, res)) return;
  res.status(403).json({
    error: 'UserApprovalRequired',
    message: 'Consent must be approved by the user. Call net.openfederation.wallet.requestConsent and send the user to the approveUrl it returns.',
  });
}
