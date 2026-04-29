import { Request, Response } from 'express';
import { config } from '../config.js';
import { query } from '../db/client.js';
import { resolveExternalHandle } from '../identity/external-handle-resolver.js';

/**
 * com.atproto.identity.resolveHandle
 *
 * Standard AT Protocol handle-to-DID resolution. Public, no auth — this is
 * how client apps decide whether "alice" means anything on this PDS before
 * they attempt a session creation.
 *
 * Two handle shapes exist in the wild:
 *   - Bare: "hackney-owner-edwards" (legacy seed data, pre-suffix).
 *   - Suffixed: "hackney-owner-edwards.openfederation.net".
 *
 * Users and communities store the bare form in `users.handle` /
 * `communities.handle`. PLC registers the fullHandle externally. For inputs
 * ending in this PDS's configured suffix we strip it, then query by the
 * bare form. Users are checked first; communities fall back.
 */
export default async function resolveHandle(req: Request, res: Response): Promise<void> {
  try {
    const rawHandle = typeof req.query.handle === 'string' ? req.query.handle : '';
    if (!rawHandle) {
      res.status(400).json({
        error: 'InvalidRequest',
        message: 'handle query parameter is required',
      });
      return;
    }

    const normalized = rawHandle.trim().toLowerCase();
    if (!normalized) {
      res.status(400).json({ error: 'InvalidRequest', message: 'handle must be non-empty' });
      return;
    }

    // Strip the PDS's own handle suffix if present. A handle like
    // "alice.openfederation.net" looks up as "alice" in the users table.
    const suffix = config.handleSuffix.toLowerCase();
    const bare =
      suffix && normalized.endsWith(suffix)
        ? normalized.slice(0, -suffix.length)
        : normalized;

    // Run both lookups in parallel — on a miss we answer 404 from whichever
    // finishes first, and the cost of the extra round-trip is negligible
    // because both are indexed single-row lookups.
    const [userResult, communityResult] = await Promise.all([
      query<{ did: string }>('SELECT did FROM users WHERE handle = $1', [bare]),
      query<{ did: string }>('SELECT did FROM communities WHERE handle = $1', [bare]),
    ]);

    const localDid = userResult.rows[0]?.did ?? communityResult.rows[0]?.did;
    if (localDid) {
      res.status(200).json({ did: localDid });
      return;
    }

    // Fall back to cross-PDS resolution via DNS TXT / well-known (#69)
    const externalDid = await resolveExternalHandle(normalized);
    if (externalDid) {
      res.status(200).json({ did: externalDid });
      return;
    }

    res.status(400).json({
      error: 'HandleNotFound',
      message: `Could not resolve handle "${rawHandle}"`,
    });
  } catch (err) {
    console.error('Error resolving handle:', err);
    res.status(500).json({
      error: 'InternalServerError',
      message: 'Failed to resolve handle',
    });
  }
}
