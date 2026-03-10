import { xrpc } from '../api-client';

export async function changePassword(currentPassword: string, newPassword: string) {
  return xrpc<{ success: boolean }>('net.openfederation.account.changePassword', {
    body: { currentPassword, newPassword },
  });
}
