/**
 * Pages that must never touch the person's own session: the signed-out
 * pen-name pages (/pen-names, /pen-names/new). A pen name made or used there
 * must not be linkable to the person's account by a request carrying both, or
 * by the person's session being refreshed from the same page.
 *
 * On these pages the auth store is never loaded from storage and never
 * refreshed. Once a tab has shown one of them, it stays that way until the
 * page is loaded afresh (so following a link from there to the glossary does
 * not quietly sign the person back in either).
 */

/** Where the auth store persists the person's session. Read here only to say whether one exists. */
export const AUTH_PERSIST_KEY = 'openfed-auth';

export function isSignedOutArea(pathname: string | null | undefined): boolean {
  return !!pathname && (pathname === '/pen-names' || pathname.startsWith('/pen-names/'));
}

let sealed = false;

/** Called when a signed-out page renders; from then on this tab keeps the person's session unloaded. */
export function sealThisTab(): void { sealed = true; }
export function isTabSealed(): boolean { return sealed; }

/**
 * Whether this browser holds a signed-in session of the person's own
 * account. Only the answer leaves this function, never the session.
 */
export function ownSessionInThisBrowser(): boolean {
  try {
    const raw = localStorage.getItem(AUTH_PERSIST_KEY);
    if (!raw) return false;
    const token = (JSON.parse(raw) as { state?: { refreshToken?: unknown } }).state?.refreshToken;
    return typeof token === 'string' && token.length > 0;
  } catch {
    return false;
  }
}
