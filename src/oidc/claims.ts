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
