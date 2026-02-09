import type { Response } from 'express';
import type { AuthRequest, AuthContext, UserRole } from './types.js';

export function requireAuth(req: AuthRequest, res: Response): req is AuthRequest & { auth: AuthContext } {
  if (!req.auth) {
    res.status(401).json({
      error: 'Unauthorized',
      message: req.authError === 'invalid' ? 'Invalid access token' : 'Missing access token',
    });
    return false;
  }
  return true;
}

export function requireRole(req: AuthRequest, res: Response, roles: UserRole[]): boolean {
  if (!requireAuth(req, res)) {
    return false;
  }

  const hasRole = roles.some((role) => req.auth.roles.includes(role));
  if (!hasRole) {
    res.status(403).json({
      error: 'Forbidden',
      message: 'Insufficient privileges',
    });
    return false;
  }

  return true;
}

export function requireApprovedUser(req: AuthRequest, res: Response): boolean {
  if (!requireAuth(req, res)) {
    return false;
  }

  if (req.auth.status !== 'approved') {
    res.status(403).json({
      error: 'AccountNotApproved',
      message: 'Your account must be approved before performing this action.',
    });
    return false;
  }

  return true;
}
