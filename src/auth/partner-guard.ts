import type { Request, Response } from 'express';
import { query } from '../db/client.js';
import { verifyPartnerKey } from './verification.js';

export interface PartnerContext {
  partnerId: string;
  name: string;
  partnerName: string;
  permissions: string[];
  rateLimitPerHour: number;
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
  const result = await verifyPartnerKey({
    rawKey: req.headers['x-partner-key'] as string | undefined,
    origin: req.headers.origin as string | undefined,
    requiredPermission,
  });
  if (!result.ok) {
    res.status(result.status).json({ error: result.code, message: result.message });
    return null;
  }
  return result.partner;
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
