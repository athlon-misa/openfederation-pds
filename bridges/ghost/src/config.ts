/**
 * Configuration, from the environment. Every value is checked at start so a
 * typo stops the bridge instead of breaking sign-in later.
 */

function required(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`${name} is required`);
  return v;
}

function url(name: string, fallback?: string): string {
  const raw = process.env[name]?.trim() || fallback;
  if (!raw) throw new Error(`${name} is required`);
  const u = new URL(raw);
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error(`${name} must be an http(s) URL`);
  return u.toString().replace(/\/+$/, '');
}

export interface BridgeConfig {
  port: number;
  /** Public address of the Ghost site, e.g. https://ghost.opennewsrooms.com */
  ghostUrl: string;
  /** Where the bridge reaches Ghost (inside Docker: http://ghost:2368). */
  ghostInternalUrl: string;
  /** Ghost Admin API key from a custom integration: "<id>:<hex secret>". */
  ghostAdminKey: { id: string; secret: Buffer };
  /** The PDS's OpenID Connect issuer, e.g. https://pds.openfederation.net/oidc */
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** Path the bridge is mounted at on the Ghost site. */
  basePath: string;
  /** Signs the short-lived cookies that carry a sign-in across redirects. */
  cookieSecret: Buffer;
  /** Cookie the Ghost SSO adapter reads (must match the adapter's config). */
  staffCookie: string;
  siteName: string;
}

export function loadConfig(): BridgeConfig {
  // "<id>:<hex secret>". Ghost 6's API returns the key's `secret` field
  // already in that form, so a value assembled as id + ':' + secret has the id
  // twice: the last two parts are the key either way.
  const key = required('GHOST_ADMIN_API_KEY');
  const [id, secret] = key.split(':').slice(-2);
  if (!id || !secret || !/^[0-9a-f]+$/i.test(secret)) {
    throw new Error('GHOST_ADMIN_API_KEY must be "<id>:<hex secret>" (Ghost Admin → Integrations → custom integration)');
  }
  const cookieSecret = required('BRIDGE_COOKIE_SECRET');
  if (cookieSecret.length < 32) throw new Error('BRIDGE_COOKIE_SECRET must be at least 32 characters');
  const basePath = (process.env.BRIDGE_BASE_PATH || '/auth/openfederation').replace(/\/+$/, '');
  if (!basePath.startsWith('/')) throw new Error('BRIDGE_BASE_PATH must start with /');
  return {
    port: parseInt(process.env.PORT || '3080', 10),
    ghostUrl: url('GHOST_URL'),
    ghostInternalUrl: url('GHOST_INTERNAL_URL', process.env.GHOST_URL),
    ghostAdminKey: { id, secret: Buffer.from(secret, 'hex') },
    issuer: url('OIDC_ISSUER'),
    clientId: required('OIDC_CLIENT_ID'),
    clientSecret: required('OIDC_CLIENT_SECRET'),
    basePath,
    cookieSecret: Buffer.from(cookieSecret, 'utf-8'),
    staffCookie: process.env.STAFF_COOKIE_NAME || 'of_ghost_sso',
    siteName: process.env.SITE_NAME || 'Ghost',
  };
}
