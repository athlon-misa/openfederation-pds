import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireApprovedUser } from '../auth/guards.js';
import { auditLog } from '../db/audit.js';
import {
  createConsentRequest,
  consentApprovalUrl,
  validateRequestedScope,
  isWalletChain,
  normalizeDappOrigin,
  assertDappOriginBinding,
  DappOriginBindingRejection,
  MAX_CONSENT_TTL_SEC,
  MIN_CONSENT_TTL_SEC,
  DEFAULT_CONSENT_TTL_SEC,
} from '../wallet/index.js';

/**
 * POST net.openfederation.wallet.requestConsent
 *
 * A dApp asks for permission to have this PDS sign with the user's Tier 1
 * wallet(s). Nothing is granted here: the response names a page on this PDS
 * where the user reads what is asked and approves it with their password.
 * Scope can be a single (chain, walletAddress), which is required for
 * transaction signing, or all Tier 1 wallets for message signing only.
 *
 * The consent asked for lasts an hour by default, at most
 * WALLET_CONSENT_MAX_HOURS (24). See src/wallet/consent-requests.ts.
 */
export default async function walletRequestConsent(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireApprovedUser(req, res)) return;

    const { dappOrigin, chain, walletAddress, ttlSeconds, allowedContracts, maxValuePerTx, maxTotalValue } = req.body ?? {};

    if (!dappOrigin || typeof dappOrigin !== 'string') {
      res.status(400).json({ error: 'InvalidRequest', message: 'dappOrigin is required' });
      return;
    }

    if (chain !== undefined && !isWalletChain(chain)) {
      res.status(400).json({ error: 'UnsupportedChain', message: 'chain must be "ethereum" or "solana" if provided' });
      return;
    }

    // Scope integrity: chain and walletAddress must be provided together or both omitted.
    if ((chain === undefined) !== (walletAddress === undefined)) {
      res.status(400).json({
        error: 'InvalidRequest',
        message: 'chain and walletAddress must be provided together (or both omitted for global scope)',
      });
      return;
    }

    let ttl = DEFAULT_CONSENT_TTL_SEC;
    if (ttlSeconds !== undefined) {
      if (typeof ttlSeconds !== 'number' || !Number.isInteger(ttlSeconds) || ttlSeconds < MIN_CONSENT_TTL_SEC) {
        res.status(400).json({
          error: 'InvalidRequest',
          message: `ttlSeconds must be an integer >= ${MIN_CONSENT_TTL_SEC}`,
        });
        return;
      }
      if (ttlSeconds > MAX_CONSENT_TTL_SEC) {
        res.status(400).json({
          error: 'InvalidRequest',
          message: `ttlSeconds may not exceed ${MAX_CONSENT_TTL_SEC} (${MAX_CONSENT_TTL_SEC / 3600} hours)`,
        });
        return;
      }
      ttl = ttlSeconds;
    }

    const normalizedAddress = walletAddress
      ? (chain === 'ethereum' ? String(walletAddress).toLowerCase() : String(walletAddress))
      : undefined;

    // Shape first, so a malformed dappOrigin stays a 400 rather than being
    // reported as an origin mismatch.
    let declaredOrigin: string;
    try {
      declaredOrigin = normalizeDappOrigin(dappOrigin);
    } catch (err) {
      res.status(400).json({ error: 'InvalidRequest', message: (err as Error).message });
      return;
    }

    // Binding the grant matters more than binding the signature: without it a
    // bearer-token holder could simply mint a consent for any origin and then
    // sign under it, so guarding only the signing endpoints would move the
    // attack one step earlier rather than stop it.
    let boundOrigin: string;
    try {
      boundOrigin = assertDappOriginBinding(req.headers.origin as string | undefined, declaredOrigin);
    } catch (err) {
      if (err instanceof DappOriginBindingRejection) {
        await auditLog('wallet.consent.originRejected', req.auth!.userId, req.auth!.did, {
          declaredOrigin: dappOrigin,
          requestOrigin: (req.headers.origin as string | undefined) ?? null,
          reason: err.code,
        });
        res.status(err.status).json({ error: err.code, message: err.message });
        return;
      }
      throw err;
    }

    const scoped = validateRequestedScope(chain as 'ethereum' | 'solana' | undefined, { allowedContracts, maxValuePerTx, maxTotalValue });
    if (!scoped.ok) {
      res.status(400).json({ error: 'InvalidRequest', message: scoped.message });
      return;
    }

    const request = await createConsentRequest({
      userDid: req.auth!.did,
      dappOrigin: boundOrigin,
      chain: chain as any,
      walletAddress: normalizedAddress,
      scope: scoped.scope,
      ttlSeconds: ttl,
    });

    await auditLog('wallet.consent.request', req.auth!.userId, req.auth!.did, {
      requestId: request.id,
      dappOrigin: request.dappOrigin,
      chain: request.chain,
      walletAddress: request.walletAddress,
      allowedContracts: request.scope.allowedContracts,
    });

    res.status(200).json({
      requestId: request.id,
      approveUrl: consentApprovalUrl(request.id),
      expiresAt: request.expiresAt,
    });
  } catch (err) {
    console.error('Error in walletRequestConsent:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'InternalServerError', message: 'Failed to request consent' });
    }
  }
}
