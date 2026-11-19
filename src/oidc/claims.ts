/**
 * What an app learns about the person signing in (ADR-005, decisions 4–6).
 *
 * `sub` is the DID: it survives handle changes, and a handle given up and
 * claimed by someone else cannot inherit the account. `did_slug` is the same
 * DID in a form apps can safely turn into a username or an email local part.
 */

export const SUPPORTED_SCOPES = ['openid', 'profile', 'email'] as const;
export type OidcScope = (typeof SUPPORTED_SCOPES)[number];

/**
 * The DID without `did:`, every other run of non-alphanumerics as `_`:
 * `did:plc:svyqejp7a6te7uuouvt3leqb` → `plc_svyqejp7a6te7uuouvt3leqb`,
 * `did:web:example.com` → `web_example_com`. Mastodon builds both the username
 * and, without an email, a placeholder address from its uid; a DID's colons
 * make that address invalid and sign-up fails.
 */
export function didSlug(did: string): string {
  return did.replace(/^did:/, '').replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

export interface SignedInPerson {
  did: string;
  /** Full handle (with this server's domain for local names), or null when unknown. */
  handle: string | null;
  displayName: string | null;
  /** Only for accounts of this server. */
  email: string | null;
  emailVerified: boolean;
}

/** Parse a space-separated scope string, keeping only supported scopes, in a stable order. */
export function parseScopes(raw: string | undefined | null): OidcScope[] {
  const asked = new Set((raw ?? '').split(/\s+/).filter(Boolean));
  return SUPPORTED_SCOPES.filter((s) => asked.has(s));
}

/** Servers whose email confirmation is passed on by default: Bluesky's. */
export const DEFAULT_TRUSTED_EMAIL_ISSUERS = ['https://bsky.social'];

/**
 * OIDC_TRUSTED_EMAIL_ISSUERS (#461): the authorization servers whose "this
 * address is confirmed" an app may rely on. Anyone can run a server and claim
 * any address is confirmed, so an address from any other server is passed on
 * as unverified (the app confirms it itself). Unset: Bluesky's; `none`: no
 * server. Accounts of this server are unaffected (their address is checked
 * here). Invalid values stop the server.
 */
export function parseTrustedEmailIssuers(raw: string | undefined): string[] {
  const value = (raw ?? '').trim();
  if (!value) return [...DEFAULT_TRUSTED_EMAIL_ISSUERS];
  if (value.toLowerCase() === 'none') return [];
  return value.split(',').map((s) => s.trim()).filter(Boolean).map((entry) => {
    let url: URL;
    try { url = new URL(entry); } catch { throw new Error(`OIDC_TRUSTED_EMAIL_ISSUERS: "${entry}" is not a URL`); }
    if (url.protocol !== 'https:') throw new Error(`OIDC_TRUSTED_EMAIL_ISSUERS: "${entry}" must be https`);
    if (url.pathname !== '/' || url.search || url.hash) throw new Error(`OIDC_TRUSTED_EMAIL_ISSUERS: "${entry}" must be an origin only`);
    return url.origin;
  });
}

/** The claims for both the ID token and userinfo. */
export function claimsFor(person: SignedInPerson, scopes: readonly OidcScope[]): Record<string, unknown> {
  const claims: Record<string, unknown> = { sub: person.did };
  if (scopes.includes('profile')) {
    claims.did = person.did;
    claims.did_slug = didSlug(person.did);
    if (person.handle) {
      claims.handle = person.handle;
      claims.preferred_username = person.handle;
    }
    claims.name = person.displayName || person.handle || didSlug(person.did);
  }
  if (scopes.includes('email') && person.email) {
    claims.email = person.email;
    claims.email_verified = person.emailVerified;
  }
  return claims;
}
