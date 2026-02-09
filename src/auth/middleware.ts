import type { Response, NextFunction } from 'express';
import type { AuthRequest } from './types.js';
import { verifyAccessToken } from './tokens.js';

export function authMiddleware(req: AuthRequest, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header) {
    req.authError = 'missing';
    next();
    return;
  }

  if (!header.startsWith('Bearer ')) {
    req.authError = 'invalid';
    next();
    return;
  }

  const token = header.slice('Bearer '.length).trim();
  if (!token) {
    req.authError = 'missing';
    next();
    return;
  }

  const auth = verifyAccessToken(token);
  if (!auth) {
    req.authError = 'invalid';
    next();
    return;
  }

  req.auth = auth;
  next();
}
