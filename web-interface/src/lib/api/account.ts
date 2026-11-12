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
