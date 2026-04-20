import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireAuth } from '../auth/guards.js';
import { getKeypairForDid } from '../repo/keypair-utils.js';
import { signServiceAuthJwt } from '../auth/service-auth.js';

const MAX_TTL_SEC = 30 * 60; // 30 minutes — matches common atproto defaults
const DEFAULT_TTL_SEC = 60;  // atproto default for service-auth JWTs

export default async function getServiceAuth(req: AuthRequest, res: Response): Promise<void> {
  if (!requireAuth(req, res)) {
    return;
  }

  // Service-auth tokens minted for *another* caller's DID would let the caller
  // impersonate the target. Only ever mint for the authenticated user's own DID.
  // (Also: a service-auth-authenticated caller cannot mint further service-auth
  // tokens — that would be a trivial amplification attack.)
  if (req.auth.authMethod === 'service-auth') {
    res.status(403).json({
      error: 'Forbidden',
      message: 'Cannot mint service-auth tokens via a service-auth session.',
    });
    return;
  }

  const aud = typeof req.query.aud === 'string' ? req.query.aud : '';
  if (!aud || !aud.startsWith('did:')) {
    res.status(400).json({ error: 'InvalidRequest', message: 'aud must be a DID' });
    return;
  }

  const nowSec = Math.floor(Date.now() / 1000);
  let exp = nowSec + DEFAULT_TTL_SEC;
  if (req.query.exp !== undefined) {
    const parsed = Number(req.query.exp);
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
      res.status(400).json({ error: 'InvalidRequest', message: 'exp must be an integer Unix timestamp' });
      return;
    }
    if (parsed <= nowSec) {
      res.status(400).json({ error: 'BadExpiration', message: 'exp must be in the future' });
      return;
    }
    if (parsed > nowSec + MAX_TTL_SEC) {
      res.status(400).json({ error: 'BadExpiration', message: `exp is capped at ${MAX_TTL_SEC} seconds from now` });
      return;
    }
    exp = parsed;
  }

  const lxm = typeof req.query.lxm === 'string' && req.query.lxm.length > 0 ? req.query.lxm : undefined;

  let keypair;
  try {
    keypair = await getKeypairForDid(req.auth.did);
  } catch {
    res.status(400).json({ error: 'NoSigningKey', message: 'No signing key available for this account' });
    return;
  }

  const token = await signServiceAuthJwt({
    keypair,
    iss: req.auth.did,
    aud,
    exp,
    lxm,
  });

  res.status(200).json({ token });
}
