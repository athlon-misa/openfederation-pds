import { Request, Response } from 'express';
import { query } from '../db/client.js';
import { requireRole } from '../auth/guards.js';
import { hashToken } from '../auth/tokens.js';
import { auditLog } from '../db/audit.js';
import { isPrivateHost } from '../federation/remote-verify.js';
import { assertPublicHttpsUrl, readLimitedText, OutboundFetchError } from '../security/outbound-fetch.js';
import { config } from '../config.js';
import type { AuthRequest } from '../auth/types.js';

interface VerifyKeyInput {
  id: string;
}

const WELL_KNOWN_PATH = '/.well-known/openfederation-partner.json';
const FETCH_TIMEOUT_MS = 5000;
const MAX_RESPONSE_BYTES = 4096;

interface OriginCheckResult {
  origin: string;
  ok: boolean;
  reason?: string;
}

/**
 * Fetch `/.well-known/openfederation-partner.json` from `origin` and confirm
 * the `token` field's SHA-256 hash matches `expectedTokenHash`. Network and
 * parse failures become `{ok: false, reason}` — no throws.
 */
export async function checkOrigin(
  origin: string,
  expectedTokenHash: string,
  opts: { production?: boolean } = {},
): Promise<OriginCheckResult> {
  const production = opts.production ?? config.env.isProduction;
  let url: URL;
  try {
    url = new URL(WELL_KNOWN_PATH, origin);
  } catch {
    return { origin, ok: false, reason: 'invalid origin URL' };
  }
  if (isPrivateHost(url.hostname)) {
    return { origin, ok: false, reason: 'origin resolves to a private/internal host' };
  }
  // The origin is something a partner manager typed, and this server is
  // about to fetch it. Looking at the hostname's spelling is not enough: a
  // public name can resolve to an internal address. In production the origin
  // must be HTTPS and every address it resolves to must be public. (Outside
  // production, plain-http origins on a developer's machine are allowed.)
  if (production) {
    try {
      url = await assertPublicHttpsUrl(url.toString());
    } catch (err) {
      const why = err instanceof OutboundFetchError ? err.message : 'origin is not reachable';
      return { origin, ok: false, reason: why };
    }
  }

  try {
    const resp = await fetch(url.toString(), {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { Accept: 'application/json' },
    });
    if (!resp.ok) {
      return { origin, ok: false, reason: `HTTP ${resp.status} fetching ${WELL_KNOWN_PATH}` };
    }
    let text: string;
    try {
      text = await readLimitedText(resp, MAX_RESPONSE_BYTES);
    } catch {
      return { origin, ok: false, reason: 'well-known response exceeded 4KB' };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { origin, ok: false, reason: 'well-known response is not valid JSON' };
    }
    if (typeof parsed !== 'object' || parsed === null) {
      return { origin, ok: false, reason: 'well-known JSON must be an object' };
    }
    const token = (parsed as Record<string, unknown>).token;
    if (typeof token !== 'string') {
      return { origin, ok: false, reason: '`token` field missing or non-string' };
    }
    if (hashToken(token) !== expectedTokenHash) {
      return { origin, ok: false, reason: 'token does not match issued verification token' };
    }
    return { origin, ok: true };
  } catch (err) {
    // The low-level error names hosts, ports and refusal codes: enough to map
    // a network from the outside. It goes to the server log, not the caller.
    console.warn(`partner.verifyKey: fetch of ${url.origin} failed:`, err instanceof Error ? err.message : err);
    return { origin, ok: false, reason: `could not fetch ${WELL_KNOWN_PATH} from the origin` };
  }
}

export default async function verifyPartnerKey(req: Request, res: Response): Promise<void> {
  if (!requireRole(req as AuthRequest, res, ['admin', 'partner-manager'])) return;
  const auth = (req as AuthRequest).auth!;

  const input: VerifyKeyInput = req.body;
  if (!input?.id) {
    res.status(400).json({ error: 'InvalidRequest', message: 'id is required' });
    return;
  }

  const keyRow = await query<{
    id: string;
    partner_name: string;
    allowed_origins: string[] | null;
    verification_state: string;
    verification_token_hash: string | null;
    status: string;
  }>(
    `SELECT id, partner_name, allowed_origins, verification_state,
            verification_token_hash, status
     FROM partner_keys WHERE id = $1`,
    [input.id],
  );

  if (keyRow.rows.length === 0) {
    res.status(404).json({ error: 'NotFound', message: 'Partner key not found' });
    return;
  }
  const key = keyRow.rows[0];

  if (key.status === 'revoked') {
    res.status(400).json({ error: 'InvalidRequest', message: 'Partner key has been revoked' });
    return;
  }
  if (key.verification_state === 'verified') {
    res.status(200).json({ id: key.id, verificationState: 'verified', alreadyVerified: true });
    return;
  }
  if (!key.verification_token_hash) {
    res.status(500).json({
      error: 'InternalServerError',
      message: 'Partner key is pending but has no verification token on record',
    });
    return;
  }

  const allowedOrigins = Array.isArray(key.allowed_origins) ? key.allowed_origins : [];
  if (allowedOrigins.length === 0) {
    res.status(400).json({ error: 'InvalidRequest', message: 'Partner key has no allowed origins to verify' });
    return;
  }

  const results = await Promise.all(
    allowedOrigins.map((origin) => checkOrigin(origin, key.verification_token_hash!)),
  );

  const allPassed = results.every((r) => r.ok);
  if (!allPassed) {
    auditLog('partner.key.verifyFailed', auth.userId, key.id, {
      partnerName: key.partner_name,
      results,
    }).catch(() => {});
    res.status(400).json({
      error: 'VerificationFailed',
      message: 'One or more allowed origins failed domain-ownership verification',
      results,
    });
    return;
  }

  await query(
    `UPDATE partner_keys
     SET verification_state = 'verified',
         verified_at = CURRENT_TIMESTAMP,
         verification_token_hash = NULL
     WHERE id = $1`,
    [key.id],
  );

  auditLog('partner.key.verified', auth.userId, key.id, {
    partnerName: key.partner_name,
    allowedOrigins,
  }).catch(() => {});

  res.status(200).json({
    id: key.id,
    verificationState: 'verified',
    verifiedOrigins: allowedOrigins,
  });
}
