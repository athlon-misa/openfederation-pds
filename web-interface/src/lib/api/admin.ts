import { xrpc } from '../api-client';
import type { InviteResponse, ListAccountsResponse, ListInvitesResponse, ListAuditResponse, ServerConfigResponse } from './types';

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

export async function listAccounts(params: { limit?: number; offset?: number; status?: string; role?: string; q?: string } = {}) {
  return xrpc<ListAccountsResponse>('net.openfederation.account.list', {
    method: 'GET',
    params: Object.fromEntries(
      Object.entries({ limit: params.limit ?? 50, offset: params.offset ?? 0, ...params })
        .filter(([, v]) => v !== undefined && v !== '')
        .map(([k, v]) => [k, String(v)])
    ) as Record<string, string | number>,
  });
}

export async function listInvites(params: { limit?: number; offset?: number; status?: string } = {}) {
  return xrpc<ListInvitesResponse>('net.openfederation.invite.list', {
    method: 'GET',
    params: Object.fromEntries(
      Object.entries({ limit: params.limit ?? 50, offset: params.offset ?? 0, ...params })
        .filter(([, v]) => v !== undefined && v !== '')
        .map(([k, v]) => [k, String(v)])
    ) as Record<string, string | number>,
  });
}

export async function listAuditLog(params: { limit?: number; offset?: number; action?: string; actorId?: string; targetId?: string; since?: string; until?: string } = {}) {
  return xrpc<ListAuditResponse>('net.openfederation.audit.list', {
    method: 'GET',
    params: Object.fromEntries(
      Object.entries({ limit: params.limit ?? 50, offset: params.offset ?? 0, ...params })
        .filter(([, v]) => v !== undefined && v !== '')
        .map(([k, v]) => [k, String(v)])
    ) as Record<string, string | number>,
  });
}

export async function getServerConfig() {
  return xrpc<ServerConfigResponse>('net.openfederation.server.getConfig', {
    method: 'GET',
  });
}

export async function suspendAccount(did: string, reason?: string) {
  return xrpc<{ subject: unknown; takedown: unknown; deactivated: unknown }>('com.atproto.admin.updateSubjectStatus', {
    body: { subject: { did }, deactivated: { applied: true, ref: reason } },
  });
}

export async function unsuspendAccount(did: string) {
  return xrpc<{ subject: unknown; takedown: unknown; deactivated: unknown }>('com.atproto.admin.updateSubjectStatus', {
    body: { subject: { did }, deactivated: { applied: false } },
  });
}

export async function takedownAccount(did: string, reason?: string) {
  return xrpc<{ subject: unknown; takedown: unknown; deactivated: unknown }>('com.atproto.admin.updateSubjectStatus', {
    body: { subject: { did }, takedown: { applied: true, ref: reason } },
  });
}

export async function reverseTakedownAccount(did: string) {
  return xrpc<{ subject: unknown; takedown: unknown; deactivated: unknown }>('com.atproto.admin.updateSubjectStatus', {
    body: { subject: { did }, takedown: { applied: false } },
  });
}

export async function exportAccount(did: string) {
  return xrpc<unknown>('net.openfederation.account.export', {
    method: 'GET',
    params: { did },
  });
}

export async function deleteAccount(did: string) {
  return xrpc<{ success: boolean }>('com.atproto.admin.deleteAccount', {
    body: { did },
  });
}
