import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  listAccounts,
  listInvites,
  approveAccount,
  rejectAccount,
  createInvite,
} from '@/lib/api/admin';
import { suspendCommunity, unsuspendCommunity, takedownCommunity, deleteCommunity, listAllCommunities } from '@/lib/api/communities';

export const adminKeys = {
  accounts: (params: Record<string, unknown>) => ['admin', 'accounts', params] as const,
  invites: (params: Record<string, unknown>) => ['admin', 'invites', params] as const,
  allCommunities: (limit: number, offset: number) => ['admin', 'communities', { limit, offset }] as const,
};

export function useAccountsQuery(params: { limit?: number; offset?: number; status?: string; role?: string; q?: string } = {}) {
  return useQuery({
    queryKey: adminKeys.accounts(params),
    queryFn: async () => {
      const result = await listAccounts(params);
      if (!result.ok) throw new Error(result.message);
      return result.data;
    },
  });
}

export function useInvitesQuery(params: { limit?: number; offset?: number; status?: string } = {}) {
  return useQuery({
    queryKey: adminKeys.invites(params),
    queryFn: async () => {
      const result = await listInvites(params);
      if (!result.ok) throw new Error(result.message);
      return result.data;
    },
  });
}

export function useAdminCommunitiesQuery(limit = 50, offset = 0) {
  return useQuery({
    queryKey: adminKeys.allCommunities(limit, offset),
    queryFn: async () => {
      const result = await listAllCommunities(limit, offset, 'all');
      if (!result.ok) throw new Error(result.message);
      return result.data;
    },
  });
}

export function useApproveAccountMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (userId: string) => {
      const result = await approveAccount(userId);
      if (!result.ok) throw new Error(result.message);
      return result.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin'] });
    },
  });
}

export function useRejectAccountMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (userId: string) => {
      const result = await rejectAccount(userId);
      if (!result.ok) throw new Error(result.message);
      return result.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin'] });
    },
  });
}

export function useCreateInviteMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ maxUses, expiresAt }: { maxUses: number; expiresAt?: string }) => {
      const result = await createInvite(maxUses, expiresAt);
      if (!result.ok) throw new Error(result.message);
      return result.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'invites'] });
    },
  });
}

export function useSuspendCommunityMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ did, reason }: { did: string; reason?: string }) => {
      const result = await suspendCommunity(did, reason);
      if (!result.ok) throw new Error(result.message);
      return result.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'communities'] });
      queryClient.invalidateQueries({ queryKey: ['communities'] });
    },
  });
}

export function useUnsuspendCommunityMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (did: string) => {
      const result = await unsuspendCommunity(did);
      if (!result.ok) throw new Error(result.message);
      return result.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'communities'] });
      queryClient.invalidateQueries({ queryKey: ['communities'] });
    },
  });
}

export function useTakedownCommunityMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ did, reason }: { did: string; reason?: string }) => {
      const result = await takedownCommunity(did, reason);
      if (!result.ok) throw new Error(result.message);
      return result.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'communities'] });
      queryClient.invalidateQueries({ queryKey: ['communities'] });
    },
  });
}

export function useAdminDeleteCommunityMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (did: string) => {
      const result = await deleteCommunity(did);
      if (!result.ok) throw new Error(result.message);
      return result.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'communities'] });
      queryClient.invalidateQueries({ queryKey: ['communities'] });
    },
  });
}
