/**
 * Binding an ATProto login to the tab that started it (PKCE-shaped).
 *
 * The verifier lives in `sessionStorage`: per tab, gone when the tab closes,
 * and it survives the full-page redirects the login makes. It is read once.
 */
import { sha256 } from '@noble/hashes/sha2';

const VERIFIER_KEY = 'openfederation_login_verifier';

function base64Url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function tabStorage(): Storage | null {
  try {
    return typeof sessionStorage !== 'undefined' ? sessionStorage : null;
  } catch {
    return null;
  }
}

/**
 * Create and remember a verifier for a login that is about to start. Returns
 * the challenge to send, or null where there is no per-tab storage to keep the
 * verifier in (the login then cannot be completed by `handleOAuthCallback`).
 */
export function newLoginVerifier(): { challenge: string } | null {
  const storage = tabStorage();
  if (!storage) return null;
  const random = new Uint8Array(32);
  globalThis.crypto.getRandomValues(random);
  const verifier = base64Url(random);
  storage.setItem(VERIFIER_KEY, verifier);
  return { challenge: base64Url(sha256(new TextEncoder().encode(verifier))) };
}

/** The verifier for the login this tab started, removed as it is read. */
export function takeLoginVerifier(): string | null {
  const storage = tabStorage();
  if (!storage) return null;
  const verifier = storage.getItem(VERIFIER_KEY);
  storage.removeItem(VERIFIER_KEY);
  return verifier;
}
