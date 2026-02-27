import { xrpc } from '../api-client';
import type { SessionResponse, GetSessionResponse, RegisterResponse, ResolveExternalResponse, ExternalCompleteResponse } from './types';

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

export async function resolveExternal(handle: string) {
  return xrpc<ResolveExternalResponse>('net.openfederation.account.resolveExternal', {
    body: { handle },
    noAuth: true,
  });
}

export async function completeExternalLogin(code: string): Promise<
  { ok: true; data: ExternalCompleteResponse } | { ok: false; status: number; error: string; message: string }
> {
  const PDS_URL = process.env.NEXT_PUBLIC_PDS_URL || 'http://localhost:3000';
  try {
    const response = await fetch(`${PDS_URL}/oauth/external/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
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
