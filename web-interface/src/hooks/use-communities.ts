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
  listPeerCommunities,
} from '@/lib/api/communities';
import { unwrapApi } from '@/lib/api/unwrap';

export const communityKeys = {
  all: ['communities'] as const,
  mine: (limit: number, offset: number) => ['communities', 'mine', { limit, offset }] as const,
  detail: (did: string) => ['communities', 'detail', did] as const,
  members: (did: string, limit: number, offset: number) => ['communities', 'members', did, { limit, offset }] as const,
  joinRequests: (did: string, limit: number, offset: number) => ['communities', 'joinRequests', did, { limit, offset }] as const,
  explore: (limit: number, offset: number, mode: string) => ['communities', 'explore', { limit, offset, mode }] as const,
  peerCommunities: ['communities', 'peer'] as const,
};

export function useMyCommunitiesQuery(limit = 50, offset = 0) {
  return useQuery({
    queryKey: communityKeys.mine(limit, offset),
    queryFn: async () => unwrapApi(await listMyCommunities(limit, offset)),
  });
}

export function useCommunityDetailQuery(did: string) {
  return useQuery({
    queryKey: communityKeys.detail(did),
    queryFn: async () => unwrapApi(await getCommunity(did)),
    staleTime: 60 * 1000, // 1 minute
  });
}

export function useMembersQuery(did: string, limit = 50, offset = 0) {
  return useQuery({
    queryKey: communityKeys.members(did, limit, offset),
    queryFn: async () => unwrapApi(await listMembers(did, limit, offset)),
    staleTime: 60 * 1000, // 1 minute
  });
}

export function useJoinRequestsQuery(did: string, limit = 50, offset = 0) {
  return useQuery({
    queryKey: communityKeys.joinRequests(did, limit, offset),
    queryFn: async () => unwrapApi(await listJoinRequests(did, limit, offset)),
    staleTime: 60 * 1000, // 1 minute
  });
}

export function useExploreCommunitiesQuery(limit = 50, offset = 0, mode: 'public' | 'all' = 'public') {
  return useQuery({
    queryKey: communityKeys.explore(limit, offset, mode),
    queryFn: async () => unwrapApi(await listAllCommunities(limit, offset, mode)),
  });
}

export function useJoinCommunityMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (did: string) => unwrapApi(await joinCommunity(did)),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['communities'] });
    },
  });
}

export function useLeaveCommunityMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (did: string) => unwrapApi(await leaveCommunity(did)),
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
    }) => unwrapApi(await updateCommunity(did, data)),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: communityKeys.detail(variables.did) });
    },
  });
}

export function useExportCommunityMutation() {
  return useMutation({
    mutationFn: async (did: string) => unwrapApi(await exportCommunity(did)),
  });
}

export function useTransferCommunityMutation() {
  return useMutation({
    mutationFn: async (did: string) => unwrapApi(await transferCommunity(did)),
  });
}

export function useResolveJoinRequestMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ requestId, action }: { requestId: string; action: 'approve' | 'reject' }) =>
      unwrapApi(await resolveJoinRequest(requestId, action)),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['communities'] });
    },
  });
}

export function useRemoveMemberMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ did, memberDid }: { did: string; memberDid: string }) =>
      unwrapApi(await removeMember(did, memberDid)),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['communities'] });
    },
  });
}

export function useDeleteCommunityMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (did: string) => unwrapApi(await deleteCommunity(did)),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['communities'] });
    },
  });
}

export function usePeerCommunitiesQuery() {
  return useQuery({
    queryKey: communityKeys.peerCommunities,
    queryFn: async () => unwrapApi(await listPeerCommunities()),
    staleTime: 5 * 60 * 1000, // 5 minutes
  });
}
