import { xrpc } from '../api-client';
import type { ListPendingResponse, InviteResponse } from './types';

export async function listPending(limit = 50, offset = 0) {
  return xrpc<ListPendingResponse>('net.openfederation.account.listPending', {
    method: 'GET',
    params: { limit, offset },
  });
}

export async function approveAccount(userId: string) {
  return xrpc<{ message: string }>('net.openfederation.account.approve', {
    body: { userId },
  });
}

export async function rejectAccount(userId: string) {
  return xrpc<{ message: string }>('net.openfederation.account.reject', {
    body: { userId },
  });
}

export async function createInvite(maxUses: number, expiresAt?: string) {
  return xrpc<InviteResponse>('net.openfederation.invite.create', {
    body: { maxUses, expiresAt: expiresAt || undefined },
  });
}
