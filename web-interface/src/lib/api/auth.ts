import { xrpc } from '../api-client';
import type { SessionResponse, GetSessionResponse, RegisterResponse } from './types';

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
