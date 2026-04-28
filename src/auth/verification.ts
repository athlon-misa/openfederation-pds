import type { AuthContext, UserRole, UserStatus } from './types.js';
import { verifyAccessToken } from './tokens.js';
import { query } from '../db/client.js';
import { config } from '../config.js';
import {
  looksLikeServiceAuthJwt,
  verifyServiceAuthJwt,
  checkServiceAuthRateLimit,
  ServiceAuthError,
} from './service-auth.js';
import { isValidPartnerKeyFormat, hashPartnerKey } from './partner-keys.js';
import { isValidOracleKeyFormat, hashOracleKey } from './oracle-keys.js';
import type { PartnerContext } from './partner-guard.js';
import type { OracleContext } from './oracle-guard.js';

type OAuthVerifier = {
  authenticateRequest(
    httpMethod: string,
    httpUrl: Readonly<URL>,
    httpHeaders: Record<string, undefined | string | string[]>,
    verifyOptions?: { audience?: [string, ...string[]]; scope?: [string, ...string[]] }
  ): Promise<{ sub: string; [key: string]: unknown }>;
};

export type AuthVerificationResult = {
  auth?: AuthContext;
  authError?: 'missing' | 'invalid';
  serviceAuthError?: { code: string; message: string; status: number };
  wwwAuthenticateHeader?: string;
};

export type PartnerVerificationResult =
  | { ok: true; partner: PartnerContext }
  | { ok: false; status: number; code: string; message: string };

export type OracleVerificationResult =
  | { ok: true; oracle: OracleContext }
  | { ok: false };

let oauthVerifier: OAuthVerifier | null = null;

export function setOAuthVerifier(verifier: OAuthVerifier | null): void {
  oauthVerifier = verifier;
}

export async function verifyRequestAuth(opts: {
  method: string;
  originalUrl: string;
  path: string;
  headers: Record<string, undefined | string | string[]>;
}): Promise<AuthVerificationResult> {
  const dpopHeader = opts.headers.dpop;
  const authHeaderRaw = opts.headers.authorization;
  const authHeader = Array.isArray(authHeaderRaw) ? authHeaderRaw[0] : authHeaderRaw;

  if (dpopHeader && authHeader?.startsWith('DPoP ') && oauthVerifier) {
    return verifyOAuthRequest(opts);
  }

  if (!authHeader) {
    return { authError: 'missing' };
  }

  if (!authHeader.startsWith('Bearer ')) {
    return { authError: 'invalid' };
  }

  const token = authHeader.slice('Bearer '.length).trim();
  if (!token) {
    return { authError: 'missing' };
  }

  if (looksLikeServiceAuthJwt(token)) {
    return verifyServiceAuthRequest(token, opts.path);
  }

  const auth = await verifyAccessToken(token);
  if (!auth) {
    return { authError: 'invalid' };
  }

  return { auth: { ...auth, authMethod: 'local' } };
}

async function verifyOAuthRequest(opts: {
  method: string;
  originalUrl: string;
  headers: Record<string, undefined | string | string[]>;
}): Promise<AuthVerificationResult> {
  try {
    const payload = await oauthVerifier!.authenticateRequest(
      opts.method,
      new URL(opts.originalUrl, config.pds.serviceUrl),
      opts.headers,
      { scope: ['atproto'] },
    );

    const auth = await authContextForLocalDid(payload.sub, 'oauth');
    return auth ? { auth } : { authError: 'invalid' };
  } catch (err: unknown) {
    const oauthErr = err as { wwwAuthenticateHeader?: string };
    return {
      authError: 'invalid',
      wwwAuthenticateHeader: oauthErr?.wwwAuthenticateHeader,
    };
  }
}

async function verifyServiceAuthRequest(token: string, path: string): Promise<AuthVerificationResult> {
  try {
    const nsidMatch = path.match(/^\/xrpc\/([^/]+)/);
    const expectedLxm = nsidMatch ? nsidMatch[1] : undefined;
    const claims = await verifyServiceAuthJwt(token, { expectedLxm });

    if (!checkServiceAuthRateLimit(claims.iss)) {
      return {
        authError: 'invalid',
        serviceAuthError: {
          code: 'RateLimitExceeded',
          message: 'Too many service-auth requests for this DID',
          status: 429,
        },
      };
    }

    const localAuth = await authContextForLocalDid(claims.iss, 'service-auth');
    if (localAuth) return { auth: localAuth };

    return {
      auth: {
        userId: claims.iss,
        handle: claims.iss,
        email: '',
        did: claims.iss,
        status: 'approved',
        roles: [],
        authMethod: 'service-auth',
      },
    };
  } catch (err) {
    if (err instanceof ServiceAuthError) {
      return {
        authError: 'invalid',
        serviceAuthError: { code: err.code, message: err.message, status: err.status },
      };
    }

    return {
      authError: 'invalid',
      serviceAuthError: {
        code: 'InvalidToken',
        message: 'Service-auth verification failed',
        status: 401,
      },
    };
  }
}

async function authContextForLocalDid(
  did: string,
  authMethod: 'oauth' | 'service-auth',
): Promise<AuthContext | null> {
  const userResult = await query<{ id: string; handle: string; email: string; status: string }>(
    'SELECT id, handle, email, status FROM users WHERE did = $1',
    [did],
  );

  if (userResult.rows.length === 0) return null;

  const user = userResult.rows[0];
  const roleResult = await query<{ role: string }>(
    'SELECT role FROM user_roles WHERE user_id = $1',
    [user.id],
  );

  return {
    userId: user.id,
    handle: user.handle,
    email: user.email || '',
    did,
    status: user.status as UserStatus,
    roles: roleResult.rows.map(r => r.role) as UserRole[],
    authMethod,
  };
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

export async function verifyPartnerKey(opts: {
  rawKey?: string;
  origin?: string;
  requiredPermission: string;
}): Promise<PartnerVerificationResult> {
  if (!opts.rawKey || !isValidPartnerKeyFormat(opts.rawKey)) {
    return { ok: false, status: 401, code: 'Unauthorized', message: 'Missing or invalid partner key' };
  }

  const keyHash = hashPartnerKey(opts.rawKey);
  const result = await query<PartnerRow>(
    `SELECT id, name, partner_name, permissions, allowed_origins, rate_limit_per_hour, status, verification_state
     FROM partner_keys WHERE key_hash = $1`,
    [keyHash],
  );

  if (result.rows.length === 0) {
    return { ok: false, status: 401, code: 'Unauthorized', message: 'Invalid partner key' };
  }

  const partner = result.rows[0];
  if (partner.status !== 'active') {
    return { ok: false, status: 401, code: 'Unauthorized', message: 'Partner key has been revoked' };
  }

  if (partner.verification_state !== 'verified') {
    return {
      ok: false,
      status: 403,
      code: 'PartnerKeyUnverified',
      message:
        'Partner key has not completed domain-ownership verification. ' +
        'Publish the verification token at /.well-known/openfederation-partner.json ' +
        'on each allowed origin, then have an admin call net.openfederation.partner.verifyKey.',
    };
  }

  if (partner.allowed_origins && partner.allowed_origins.length > 0) {
    if (!opts.origin || !partner.allowed_origins.includes(opts.origin)) {
      return { ok: false, status: 403, code: 'Forbidden', message: 'Origin not allowed for this partner key' };
    }
  }

  const permissions = Array.isArray(partner.permissions) ? partner.permissions : [];
  if (!permissions.includes(opts.requiredPermission)) {
    return { ok: false, status: 403, code: 'Forbidden', message: 'Partner key does not have the required permission' };
  }

  query('UPDATE partner_keys SET last_used_at = CURRENT_TIMESTAMP WHERE id = $1', [partner.id]).catch(() => {});

  return {
    ok: true,
    partner: {
      partnerId: partner.id,
      name: partner.name,
      partnerName: partner.partner_name,
      permissions,
      rateLimitPerHour: partner.rate_limit_per_hour,
    },
  };
}

export async function verifyOracleKey(opts: {
  rawKey?: string;
  origin?: string;
}): Promise<OracleVerificationResult> {
  if (!opts.rawKey || !isValidOracleKeyFormat(opts.rawKey)) return { ok: false };

  const keyHash = hashOracleKey(opts.rawKey);
  const result = await query<{
    id: string;
    community_did: string;
    name: string;
    status: string;
    allowed_origins: string[] | null;
  }>(
    `SELECT id, community_did, name, status, allowed_origins
     FROM oracle_credentials WHERE key_hash = $1`,
    [keyHash],
  );

  if (result.rows.length === 0) return { ok: false };

  const credential = result.rows[0];
  if (credential.status !== 'active') return { ok: false };

  if (credential.allowed_origins && credential.allowed_origins.length > 0) {
    if (!opts.origin || !credential.allowed_origins.includes(opts.origin)) return { ok: false };
  }

  query(
    'UPDATE oracle_credentials SET last_used_at = CURRENT_TIMESTAMP, proofs_submitted = proofs_submitted + 1 WHERE id = $1',
    [credential.id],
  ).catch(() => {});

  return {
    ok: true,
    oracle: {
      credentialId: credential.id,
      communityDid: credential.community_did,
      name: credential.name,
    },
  };
}
