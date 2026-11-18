/**
 * ID tokens and userinfo access tokens (ADR-005, decision 8).
 */
import { SignJWT, jwtVerify } from 'jose';
import { getOidcSigningKey } from './keys.js';

export const ID_TOKEN_TTL_SECONDS = 600;
export const ACCESS_TOKEN_TTL_SECONDS = 600;

export async function signIdToken(input: {
  issuer: string;
  clientId: string;
  claims: Record<string, unknown>;
  nonce: string | null;
  authTime: Date | null;
}): Promise<string> {
  const key = await getOidcSigningKey();
  const { sub, ...rest } = input.claims;
  return new SignJWT({
    ...rest,
    ...(input.nonce ? { nonce: input.nonce } : {}),
    ...(input.authTime ? { auth_time: Math.floor(input.authTime.getTime() / 1000) } : {}),
  })
    .setProtectedHeader({ alg: 'RS256', kid: key.kid, typ: 'JWT' })
    .setIssuer(input.issuer)
    .setSubject(String(sub))
    .setAudience(input.clientId)
    .setIssuedAt()
    .setExpirationTime(`${ID_TOKEN_TTL_SECONDS}s`)
    .sign(key.privateKey);
}

/**
 * An access token good only for this provider's userinfo. It carries the
 * claims decided at sign-in, so userinfo answers exactly what the ID token
 * said, also for accounts of other servers that have no row here.
 */
export async function signAccessToken(input: {
  issuer: string;
  clientId: string;
  scope: string;
  claims: Record<string, unknown>;
}): Promise<string> {
  const key = await getOidcSigningKey();
  return new SignJWT({ scope: input.scope, client_id: input.clientId, userinfo: input.claims })
    .setProtectedHeader({ alg: 'RS256', kid: key.kid, typ: 'at+jwt' })
    .setIssuer(input.issuer)
    .setSubject(String(input.claims.sub))
    .setAudience(`${input.issuer}/userinfo`)
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TOKEN_TTL_SECONDS}s`)
    .sign(key.privateKey);
}

/** The userinfo claims of a valid access token, or null. */
export async function verifyAccessToken(issuer: string, token: string): Promise<Record<string, unknown> | null> {
  try {
    const key = await getOidcSigningKey();
    const { payload, protectedHeader } = await jwtVerify(token, key.publicKey, {
      issuer,
      audience: `${issuer}/userinfo`,
      algorithms: ['RS256'],
    });
    if (protectedHeader.typ !== 'at+jwt') return null;
    const claims = payload.userinfo;
    if (!claims || typeof claims !== 'object' || (claims as { sub?: unknown }).sub !== payload.sub) return null;
    return claims as Record<string, unknown>;
  } catch {
    return null;
  }
}
