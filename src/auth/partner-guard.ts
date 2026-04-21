import type { Request, Response } from 'express';
import { query } from '../db/client.js';
import { isValidPartnerKeyFormat, hashPartnerKey } from './partner-keys.js';

export interface PartnerContext {
  partnerId: string;
  name: string;
  partnerName: string;
  permissions: string[];
  rateLimitPerHour: number;
}

interface PartnerRow {
  id: string;
  name: string;
  partner_name: string;
  permissions: string[];
  allowed_origins: string[] | null;
  rate_limit_per_hour: number;
  status: string;
  verification_state: string;
}

/**
 * Validate an X-Partner-Key header and return the partner context.
 * Sends 401/403 and returns null if validation fails.
 */
export async function validatePartnerKey(
  req: Request,
  res: Response,
  requiredPermission: string
): Promise<PartnerContext | null> {
  const rawKey = req.headers['x-partner-key'] as string | undefined;

  if (!rawKey || !isValidPartnerKeyFormat(rawKey)) {
    res.status(401).json({ error: 'Unauthorized', message: 'Missing or invalid partner key' });
    return null;
  }

  const keyHash = hashPartnerKey(rawKey);

  const result = await query<PartnerRow>(
    `SELECT id, name, partner_name, permissions, allowed_origins, rate_limit_per_hour, status, verification_state
     FROM partner_keys WHERE key_hash = $1`,
    [keyHash]
  );

  if (result.rows.length === 0) {
    res.status(401).json({ error: 'Unauthorized', message: 'Invalid partner key' });
    return null;
  }

  const partner = result.rows[0];

  if (partner.status !== 'active') {
    res.status(401).json({ error: 'Unauthorized', message: 'Partner key has been revoked' });
    return null;
  }

  if (partner.verification_state !== 'verified') {
    res.status(403).json({
      error: 'PartnerKeyUnverified',
      message:
        'Partner key has not completed domain-ownership verification. ' +
        'Publish the verification token at /.well-known/openfederation-partner.json ' +
        'on each allowed origin, then have an admin call net.openfederation.partner.verifyKey.',
    });
    return null;
  }

  // Validate origin if allowed_origins is set
  if (partner.allowed_origins && partner.allowed_origins.length > 0) {
    const origin = req.headers.origin as string | undefined;
    if (!origin || !partner.allowed_origins.includes(origin)) {
      res.status(403).json({ error: 'Forbidden', message: 'Origin not allowed for this partner key' });
      return null;
    }
  }

  // Check permission
  const permissions: string[] = Array.isArray(partner.permissions)
    ? partner.permissions
    : [];
  if (!permissions.includes(requiredPermission)) {
    res.status(403).json({ error: 'Forbidden', message: 'Partner key does not have the required permission' });
    return null;
  }

  // Update last_used_at (fire-and-forget)
  query('UPDATE partner_keys SET last_used_at = CURRENT_TIMESTAMP WHERE id = $1', [partner.id]).catch(() => {});

  return {
    partnerId: partner.id,
    name: partner.name,
    partnerName: partner.partner_name,
    permissions,
    rateLimitPerHour: partner.rate_limit_per_hour,
  };
}

// Cached partner origins for CORS (5-min TTL)
let cachedOrigins: string[] = [];
let cachedAt = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Get all allowed origins from active partner keys (cached 5 min).
 */
export async function getCachedPartnerOrigins(): Promise<string[]> {
  if (Date.now() - cachedAt < CACHE_TTL_MS) {
    return cachedOrigins;
  }
  try {
    const result = await query<{ allowed_origins: string[] | null }>(
      `SELECT allowed_origins FROM partner_keys
       WHERE status = 'active'
         AND verification_state = 'verified'
         AND allowed_origins IS NOT NULL`
    );
    const origins = new Set<string>();
    for (const row of result.rows) {
      if (Array.isArray(row.allowed_origins)) {
        for (const o of row.allowed_origins) origins.add(o);
      }
    }
    cachedOrigins = [...origins];
    cachedAt = Date.now();
  } catch {
    // On error, keep stale cache rather than breaking CORS
  }
  return cachedOrigins;
}
