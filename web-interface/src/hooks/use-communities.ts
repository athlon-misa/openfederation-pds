import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  listMyCommunities,
  getCommunity,
  listMembers,
  listJoinRequests,
  listAllCommunities,
  joinCommunity,
  leaveCommunity,
  updateCommunity,
  exportCommunity,
  transferCommunity,
  resolveJoinRequest,
  removeMember,
  deleteCommunity,
} from '@/lib/api/communities';

export const communityKeys = {
  all: ['communities'] as const,
  mine: (limit: number, offset: number) => ['communities', 'mine', { limit, offset }] as const,
  detail: (did: string) => ['communities', 'detail', did] as const,
  members: (did: string, limit: number, offset: number) => ['communities', 'members', did, { limit, offset }] as const,
  joinRequests: (did: string, limit: number, offset: number) => ['communities', 'joinRequests', did, { limit, offset }] as const,
  explore: (limit: number, offset: number, mode: string) => ['communities', 'explore', { limit, offset, mode }] as const,
};

export function useMyCommunitiesQuery(limit = 50, offset = 0) {
  return useQuery({
    queryKey: communityKeys.mine(limit, offset),
    queryFn: async () => {
      const result = await listMyCommunities(limit, offset);
      if (!result.ok) throw new Error(result.message);
      return result.data;
    },
  });
}

export function useCommunityDetailQuery(did: string) {
  return useQuery({
    queryKey: communityKeys.detail(did),
    queryFn: async () => {
      const result = await getCommunity(did);
      if (!result.ok) throw new Error(result.message);
      return result.data;
    },
  });
}

export function useMembersQuery(did: string, limit = 50, offset = 0) {
  return useQuery({
    queryKey: communityKeys.members(did, limit, offset),
    queryFn: async () => {
      const result = await listMembers(did, limit, offset);
      if (!result.ok) throw new Error(result.message);
      return result.data;
    },
  });
}

export function useJoinRequestsQuery(did: string, limit = 50, offset = 0) {
  return useQuery({
    queryKey: communityKeys.joinRequests(did, limit, offset),
    queryFn: async () => {
      const result = await listJoinRequests(did, limit, offset);
      if (!result.ok) throw new Error(result.message);
      return result.data;
    },
  });
}

export function useExploreCommunitiesQuery(limit = 50, offset = 0, mode: 'public' | 'all' = 'public') {
  return useQuery({
    queryKey: communityKeys.explore(limit, offset, mode),
    queryFn: async () => {
      const result = await listAllCommunities(limit, offset, mode);
      if (!result.ok) throw new Error(result.message);
      return result.data;
    },
  });
}

export function useJoinCommunityMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (did: string) => {
      const result = await joinCommunity(did);
      if (!result.ok) throw new Error(result.message);
      return result.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['communities'] });
    },
  });
}

export function useLeaveCommunityMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (did: string) => {
      const result = await leaveCommunity(did);
      if (!result.ok) throw new Error(result.message);
      return result.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['communities'] });
    },
  });
}

export function useUpdateCommunityMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      did,
      data,
    }: {
      did: string;
      data: { displayName?: string; description?: string; visibility?: 'public' | 'private'; joinPolicy?: 'open' | 'approval' };
    }) => {
      const result = await updateCommunity(did, data);
      if (!result.ok) throw new Error(result.message);
      return result.data;
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: communityKeys.detail(variables.did) });
    },
  });
}

export function useExportCommunityMutation() {
  return useMutation({
    mutationFn: async (did: string) => {
      const result = await exportCommunity(did);
      if (!result.ok) throw new Error(result.message);
      return result.data;
    },
  });
}

export function useTransferCommunityMutation() {
  return useMutation({
    mutationFn: async (did: string) => {
      const result = await transferCommunity(did);
      if (!result.ok) throw new Error(result.message);
      return result.data;
    },
  });
}

export function useResolveJoinRequestMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ requestId, action }: { requestId: string; action: 'approve' | 'reject' }) => {
      const result = await resolveJoinRequest(requestId, action);
      if (!result.ok) throw new Error(result.message);
      return result.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['communities'] });
    },
  });
}

export function useRemoveMemberMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ did, memberDid }: { did: string; memberDid: string }) => {
      const result = await removeMember(did, memberDid);
      if (!result.ok) throw new Error(result.message);
      return result.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['communities'] });
    },
  });
}

export function useDeleteCommunityMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (did: string) => {
      const result = await deleteCommunity(did);
      if (!result.ok) throw new Error(result.message);
      return result.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['communities'] });
    },
  });
}
