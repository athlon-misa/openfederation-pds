import { xrpc } from '../api-client';
import type { ApiResult, SessionResponse, GetSessionResponse, RegisterResponse, ResolveExternalResponse, ExternalCompleteResponse } from './types';

export async function createSession(identifier: string, password: string) {
  return xrpc<SessionResponse>('com.atproto.server.createSession', {
    body: { identifier, password },
    noAuth: true,
  });
}

export async function refreshSession(refreshJwt: string) {
  return xrpc<SessionResponse>('com.atproto.server.refreshSession', {
    body: { refreshJwt },
    noAuth: true,
  });
}

export async function deleteSession(refreshJwt: string): Promise<ApiResult<{ success: boolean }>> {
  return xrpc<{ success: boolean }>('com.atproto.server.deleteSession', {
    method: 'POST',
    body: { refreshJwt },
  });
}

export async function getSession() {
  return xrpc<GetSessionResponse>('com.atproto.server.getSession', {
    method: 'GET',
  });
}

export async function registerAccount(handle: string, email: string, password: string, inviteCode?: string) {
  return xrpc<RegisterResponse>('net.openfederation.account.register', {
    body: { handle, email, password, inviteCode },
    noAuth: true,
  });
}

/**
 * Where the login verifier lives between starting the flow and coming back.
 *
 * sessionStorage rather than localStorage: it is scoped to this tab, so a code
 * delivered to a different tab or window cannot borrow it, and it disappears
 * when the tab closes.
 */
const VERIFIER_KEY = 'of_login_verifier';

function base64Url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sha256Base64Url(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return base64Url(new Uint8Array(digest));
}

/** Read and clear the verifier — a login attempt gets exactly one shot at it. */
export function takeLoginVerifier(): string | null {
  if (typeof sessionStorage === 'undefined') return null;
  const v = sessionStorage.getItem(VERIFIER_KEY);
  sessionStorage.removeItem(VERIFIER_KEY);
  return v;
}

export async function resolveExternal(handle: string) {
  // PKCE-style binding: keep a secret in this tab, send only its hash. The PDS
  // ties the hash to the handoff code it later issues, so a code delivered to
  // any other browser cannot be redeemed (#146).
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  const codeChallenge = await sha256Base64Url(verifier);
  sessionStorage.setItem(VERIFIER_KEY, verifier);

  return xrpc<ResolveExternalResponse>('net.openfederation.account.resolveExternal', {
    body: { handle, codeChallenge },
    noAuth: true,
  });
}

export async function completeExternalLogin(code: string): Promise<
  { ok: true; data: ExternalCompleteResponse } | { ok: false; status: number; error: string; message: string }
> {
  const PDS_URL = process.env.NEXT_PUBLIC_PDS_URL || 'http://localhost:3000';

  // Refuse outright if this tab did not start the login. Without this a victim
  // could be sent /callback?code=<attacker's code> and be silently signed in as
  // the attacker; the server-side check covers it too, but failing here means
  // an unbound code is never even presented (#146).
  const codeVerifier = takeLoginVerifier();
  if (!codeVerifier) {
    return {
      ok: false,
      status: 400,
      error: 'InvalidCode',
      message: 'This login was not started in this tab. Please sign in again.',
    };
  }

  try {
    const response = await fetch(`${PDS_URL}/oauth/external/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, codeVerifier }),
    });
    const data = await response.json();
    if (!response.ok) {
      return { ok: false, status: response.status, error: data.error || 'UnknownError', message: data.message || 'Failed to complete login' };
    }
    return { ok: true, data: data as ExternalCompleteResponse };
  } catch (err) {
    return { ok: false, status: 0, error: 'NetworkError', message: err instanceof Error ? err.message : 'Network request failed' };
  }
}
