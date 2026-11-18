/**
 * Short-lived, HMAC-signed cookies that carry a sign-in across redirects
 * (the PKCE verifier and nonce on the way out, the verified identity of a
 * reader who still has to give an email). Nothing is stored server-side.
 */
import crypto from 'crypto';

export function seal(secret: Buffer, value: unknown, ttlSeconds: number): string {
  const body = Buffer.from(JSON.stringify({ v: value, exp: Math.floor(Date.now() / 1000) + ttlSeconds })).toString('base64url');
  const mac = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${mac}`;
}

export function unseal<T>(secret: Buffer, sealed: string | undefined): T | null {
  if (!sealed) return null;
  const [body, mac] = sealed.split('.');
  if (!body || !mac) return null;
  const want = crypto.createHmac('sha256', secret).update(body).digest();
  const got = Buffer.from(mac, 'base64url');
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
  try {
    const { v, exp } = JSON.parse(Buffer.from(body, 'base64url').toString('utf-8')) as { v: T; exp: number };
    return exp > Math.floor(Date.now() / 1000) ? v : null;
  } catch {
    return null;
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function cookie(name: string, value: string, opts: { path: string; maxAge: number; secure: boolean }): string {
  return `${name}=${encodeURIComponent(value)}; Path=${opts.path}; Max-Age=${opts.maxAge}; HttpOnly; SameSite=Lax${opts.secure ? '; Secure' : ''}`;
}
