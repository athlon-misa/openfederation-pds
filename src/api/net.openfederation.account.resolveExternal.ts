/**
 * net.openfederation.account.resolveExternal
 *
 * Resolves an external ATProto handle and initiates the OAuth flow
 * to authenticate the user via their home PDS.
 *
 * Input: { handle: string }
 * Output: { redirectUrl: string }
 */

import { Request, Response } from 'express';
import { getExternalOAuthClient } from '../oauth/external-client.js';

export default async function resolveExternal(req: Request, res: Response): Promise<void> {
  try {
    const { handle } = req.body || {};

    if (!handle || typeof handle !== 'string') {
      res.status(400).json({
        error: 'InvalidRequest',
        message: 'handle is required',
      });
      return;
    }

    const client = getExternalOAuthClient();
    if (!client) {
      res.status(503).json({
        error: 'ServiceUnavailable',
        message: 'External OAuth login is not available',
      });
      return;
    }

    // The caller keeps a secret verifier and sends only its SHA-256. We stash
    // the challenge in the OAuth `state`, which the ATProto client persists and
    // hands back at the callback, so the handoff code minted there can be bound
    // to the browser that started the flow. Without it the code is a bare
    // bearer and an attacker can log a victim in as themselves (#146).
    const { codeChallenge } = req.body || {};
    if (codeChallenge !== undefined
        && (typeof codeChallenge !== 'string' || codeChallenge.length < 16 || codeChallenge.length > 256)) {
      res.status(400).json({
        error: 'InvalidRequest',
        message: 'codeChallenge must be a base64url SHA-256 digest',
      });
      return;
    }

    // Resolve handle → DID → PDS → AS metadata → PAR → redirect URL
    const redirectUrl = await client.authorize(handle.trim(), {
      signal: AbortSignal.timeout(30_000),
      ...(codeChallenge ? { state: JSON.stringify({ codeChallenge }) } : {}),
    });

    res.json({ redirectUrl: redirectUrl.toString() });
  } catch (error: unknown) {
    console.error('Error resolving external handle:', error);

    const message = error instanceof Error ? error.message : 'Failed to resolve external handle';
    res.status(400).json({
      error: 'ResolutionFailed',
      message,
    });
  }
}
