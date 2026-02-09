import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireAuth } from '../auth/guards.js';

export default async function getSession(req: AuthRequest, res: Response): Promise<void> {
  if (!requireAuth(req, res)) {
    return;
  }

  res.status(200).json({
    did: req.auth.did,
    handle: req.auth.handle,
    email: req.auth.email,
    active: true,
    status: req.auth.status,
    roles: req.auth.roles,
  });
}
