import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  listAccounts,
  listInvites,
  approveAccount,
  rejectAccount,
  createInvite,
  suspendAccount,
  unsuspendAccount,
  takedownAccount,
  reverseTakedownAccount,
  exportAccount,
  deleteAccount,
  listPartnerKeys,
  createPartnerKey,
  revokePartnerKey,
  updateRoles,
} from '@/lib/api/admin';
import { suspendCommunity, unsuspendCommunity, takedownCommunity, deleteCommunity, listAllCommunities } from '@/lib/api/communities';
import { unwrapApi } from '@/lib/api/unwrap';

export const adminKeys = {
  accounts: (params: Record<string, unknown>) => ['admin', 'accounts', params] as const,
  invites: (params: Record<string, unknown>) => ['admin', 'invites', params] as const,
  allCommunities: (limit: number, offset: number) => ['admin', 'communities', { limit, offset }] as const,
  partnerKeys: () => ['admin', 'partnerKeys'] as const,
};

export function useAccountsQuery(params: { limit?: number; offset?: number; status?: string; role?: string; q?: string } = {}) {
  return useQuery({
    queryKey: adminKeys.accounts(params),
    queryFn: async () => unwrapApi(await listAccounts(params)),
    staleTime: 2 * 60 * 1000, // 2 minutes — admin data doesn't change rapidly
  });
}

export function useInvitesQuery(params: { limit?: number; offset?: number; status?: string } = {}) {
  return useQuery({
    queryKey: adminKeys.invites(params),
    queryFn: async () => unwrapApi(await listInvites(params)),
    staleTime: 2 * 60 * 1000, // 2 minutes — admin data doesn't change rapidly
  });
}

export function useAdminCommunitiesQuery(limit = 50, offset = 0) {
  return useQuery({
    queryKey: adminKeys.allCommunities(limit, offset),
    queryFn: async () => unwrapApi(await listAllCommunities(limit, offset, 'all')),
    staleTime: 2 * 60 * 1000, // 2 minutes — admin data doesn't change rapidly
  });
}

export function useApproveAccountMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (userId: string) => unwrapApi(await approveAccount(userId)),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin'] });
    },
  });
}

export function useRejectAccountMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (userId: string) => unwrapApi(await rejectAccount(userId)),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin'] });
    },
  });
}

export function useCreateInviteMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ maxUses, expiresAt }: { maxUses: number; expiresAt?: string }) =>
      unwrapApi(await createInvite(maxUses, expiresAt)),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'invites'] });
    },
  });
}

export function useSuspendAccountMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ did, reason }: { did: string; reason?: string }) =>
      unwrapApi(await suspendAccount(did, reason)),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin'] });
    },
  });
}

export function useUnsuspendAccountMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (did: string) => unwrapApi(await unsuspendAccount(did)),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin'] });
    },
  });
}

export function useTakedownAccountMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ did, reason }: { did: string; reason?: string }) =>
      unwrapApi(await takedownAccount(did, reason)),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin'] });
    },
  });
}

export function useReverseTakedownAccountMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (did: string) => unwrapApi(await reverseTakedownAccount(did)),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin'] });
    },
  });
}

export function useExportAccountMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (did: string) => unwrapApi(await exportAccount(did)),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin'] });
    },
  });
}

export function useDeleteAccountMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (did: string) => unwrapApi(await deleteAccount(did)),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin'] });
    },
  });
}

export function useSuspendCommunityMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ did, reason }: { did: string; reason?: string }) =>
      unwrapApi(await suspendCommunity(did, reason)),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'communities'] });
      queryClient.invalidateQueries({ queryKey: ['communities'] });
    },
  });
}

export function useUnsuspendCommunityMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (did: string) => unwrapApi(await unsuspendCommunity(did)),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'communities'] });
      queryClient.invalidateQueries({ queryKey: ['communities'] });
    },
  });
}

export function useTakedownCommunityMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ did, reason }: { did: string; reason?: string }) =>
      unwrapApi(await takedownCommunity(did, reason)),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'communities'] });
      queryClient.invalidateQueries({ queryKey: ['communities'] });
    },
  });
}

export function usePartnerKeysQuery() {
  return useQuery({
    queryKey: adminKeys.partnerKeys(),
    queryFn: async () => unwrapApi(await listPartnerKeys()),
  });
}

export function useCreatePartnerKeyMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: Parameters<typeof createPartnerKey>[0]) => unwrapApi(await createPartnerKey(input)),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'partnerKeys'] });
    },
  });
}

export function useRevokePartnerKeyMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => unwrapApi(await revokePartnerKey(id)),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'partnerKeys'] });
    },
  });
}

export function useUpdateRolesMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ did, addRoles, removeRoles }: { did: string; addRoles?: string[]; removeRoles?: string[] }) =>
      unwrapApi(await updateRoles(did, addRoles, removeRoles)),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin'] });
    },
  });
}

export function useAdminDeleteCommunityMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (did: string) => unwrapApi(await deleteCommunity(did)),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'communities'] });
      queryClient.invalidateQueries({ queryKey: ['communities'] });
    },
  });
}
