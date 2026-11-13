import { xrpc } from '../api-client';

export async function changePassword(currentPassword: string, newPassword: string) {
  return xrpc<{ success: boolean }>('net.openfederation.account.changePassword', {
    body: { currentPassword, newPassword },
  });
}

/** Emails a reset link if the handle or email belongs to an account here. Always succeeds, so it reveals nothing. */
export async function requestPasswordReset(identifier: string) {
  return xrpc<{ success: boolean }>('net.openfederation.account.requestPasswordReset', {
    body: { identifier },
    noAuth: true,
  });
}

export interface SessionInfo {
  id: string;
  createdAt?: string;
  lastUsedAt?: string;
  expiresAt: string;
  isCurrent?: boolean;
}

/** Where this account is signed in. */
export async function listSessions() {
  return xrpc<{ sessions: SessionInfo[] }>('net.openfederation.account.listSessions', { method: 'GET' });
}

/** Sign out one device (by the session id shown), or every device but this one. */
export async function revokeSession(p: { sessionId: string } | { revokeAll: true }) {
  return xrpc<{ revokedCount: number }>('net.openfederation.account.revokeSession', { body: p });
}
