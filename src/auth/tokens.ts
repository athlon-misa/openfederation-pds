import crypto from 'crypto';
import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { config } from '../config.js';
import type { AuthContext, UserRole, UserStatus } from './types.js';
import { query } from '../db/client.js';

interface AccessTokenPayload extends JWTPayload {
  sub: string;
  handle: string;
  email: string;
  did: string;
  roles: UserRole[];
  status: UserStatus;
  tokenVersion: number;
}

// Pre-encode the secret once at module load (jose requires Uint8Array)
const encodedSecret = new TextEncoder().encode(config.auth.jwtSecret);

export async function signAccessToken(context: AuthContext): Promise<string> {
  if (!Number.isInteger(context.tokenVersion) || context.tokenVersion! < 0) {
    throw new Error('Cannot issue access token without a valid token version');
  }
  return new SignJWT({
    handle: context.handle,
    email: context.email,
    did: context.did,
    roles: context.roles,
    status: context.status,
    tokenVersion: context.tokenVersion,
  } as Record<string, unknown>)
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(context.userId)
    .setExpirationTime(config.auth.accessTokenTtl)
    .sign(encodedSecret);
}

type TokenVersionResolver = (userId: string) => Promise<number | null>;

const databaseTokenVersionResolver: TokenVersionResolver = async (userId) => {
  const current = await query<{ token_version: number }>(
    'SELECT token_version FROM users WHERE id = $1', [userId],
  );
  return current.rows[0]?.token_version ?? null;
};

let resolveTokenVersion: TokenVersionResolver = databaseTokenVersionResolver;

/** Test seam for the database-backed token-version check. */
export function setTokenVersionResolverForTests(resolver: TokenVersionResolver | null): void {
  resolveTokenVersion = resolver ?? databaseTokenVersionResolver;
}

export async function verifyAccessToken(token: string): Promise<AuthContext | null> {
  try {
    const { payload } = await jwtVerify(token, encodedSecret, {
      algorithms: ['HS256'],
    });

    const p = payload as AccessTokenPayload;
    if (!p?.sub || !p.handle || p.email == null || !p.did || !p.roles || !Number.isInteger(p.tokenVersion)) {
      return null;
    }
    if (await resolveTokenVersion(p.sub) !== p.tokenVersion) return null;

    return {
      userId: p.sub,
      handle: p.handle,
      email: p.email,
      did: p.did,
      roles: p.roles,
      status: p.status,
      tokenVersion: p.tokenVersion,
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
