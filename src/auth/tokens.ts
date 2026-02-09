import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import type { AuthContext, UserRole, UserStatus } from './types.js';

interface AccessTokenPayload {
  sub: string;
  handle: string;
  email: string;
  did: string;
  roles: UserRole[];
  status: UserStatus;
}

export function signAccessToken(context: AuthContext): string {
  const payload: AccessTokenPayload = {
    sub: context.userId,
    handle: context.handle,
    email: context.email,
    did: context.did,
    roles: context.roles,
    status: context.status,
  };

  return jwt.sign(payload, config.auth.jwtSecret, {
    expiresIn: config.auth.accessTokenTtl,
  } as jwt.SignOptions);
}

export function verifyAccessToken(token: string): AuthContext | null {
  try {
    const payload = jwt.verify(token, config.auth.jwtSecret) as AccessTokenPayload;
    if (!payload?.sub || !payload.handle || !payload.email || !payload.did || !payload.roles) {
      return null;
    }

    return {
      userId: payload.sub,
      handle: payload.handle,
      email: payload.email,
      did: payload.did,
      roles: payload.roles,
      status: payload.status,
    };
  } catch {
    return null;
  }
}

export function generateRefreshToken(): { token: string; hash: string } {
  const token = crypto.randomBytes(48).toString('base64url');
  return { token, hash: hashToken(token) };
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function refreshTtlMs(): number {
  return parseDurationMs(config.auth.refreshTokenTtl, 30 * 24 * 60 * 60 * 1000);
}

function parseDurationMs(value: string, fallbackMs: number): number {
  const match = /^(\d+)([smhd])$/.exec(value.trim());
  if (!match) {
    return fallbackMs;
  }

  const amount = Number(match[1]);
  const unit = match[2];
  const multipliers: Record<string, number> = {
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
  };

  return amount * (multipliers[unit] || 1);
}
