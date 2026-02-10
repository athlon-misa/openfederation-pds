import { xrpc } from '../api-client';
import type {
  CommunityCreateResponse,
  CommunityDetail,
  CommunityExportData,
  CommunityTransferPackage,
  JoinCommunityResponse,
  LeaveCommunityResponse,
  ListAllCommunitiesResponse,
  ListCommunitiesResponse,
  ListJoinRequestsResponse,
  ListMembersResponse,
  ResolveJoinRequestResponse,
  SuspendCommunityResponse,
  TakedownCommunityResponse,
  UnsuspendCommunityResponse,
  UpdateCommunityResponse,
} from './types';

export async function createCommunity(
  handle: string,
  didMethod: 'plc' | 'web',
  options?: {
    domain?: string;
    displayName?: string;
    description?: string;
    visibility?: 'public' | 'private';
    joinPolicy?: 'open' | 'approval';
  }
) {
  return xrpc<CommunityCreateResponse>('net.openfederation.community.create', {
    body: { handle, didMethod, ...options },
  });
}

export async function listMyCommunities(limit = 50, offset = 0) {
  return xrpc<ListCommunitiesResponse>('net.openfederation.community.listMine', {
    method: 'GET',
    params: { limit, offset },
  });
}

export async function getCommunity(did: string) {
  return xrpc<CommunityDetail>('net.openfederation.community.get', {
    method: 'GET',
    params: { did },
  });
}

export async function listAllCommunities(limit = 50, offset = 0, mode: 'public' | 'all' = 'public') {
  return xrpc<ListAllCommunitiesResponse>('net.openfederation.community.listAll', {
    method: 'GET',
    params: { limit, offset, mode },
  });
}

export async function updateCommunity(
  did: string,
  data: {
    displayName?: string;
    description?: string;
    visibility?: 'public' | 'private';
    joinPolicy?: 'open' | 'approval';
  }
) {
  return xrpc<UpdateCommunityResponse>('net.openfederation.community.update', {
    body: { did, ...data },
  });
}

export async function joinCommunity(did: string) {
  return xrpc<JoinCommunityResponse>('net.openfederation.community.join', {
    body: { did },
  });
}

export async function leaveCommunity(did: string) {
  return xrpc<LeaveCommunityResponse>('net.openfederation.community.leave', {
    body: { did },
  });
}

export async function listMembers(did: string, limit = 50, offset = 0) {
  return xrpc<ListMembersResponse>('net.openfederation.community.listMembers', {
    method: 'GET',
    params: { did, limit, offset },
  });
}

export async function listJoinRequests(did: string, limit = 50, offset = 0) {
  return xrpc<ListJoinRequestsResponse>('net.openfederation.community.listJoinRequests', {
    method: 'GET',
    params: { did, limit, offset },
  });
}

export async function resolveJoinRequest(requestId: string, action: 'approve' | 'reject') {
  return xrpc<ResolveJoinRequestResponse>('net.openfederation.community.resolveJoinRequest', {
    body: { requestId, action },
  });
}

export async function exportCommunity(did: string) {
  return xrpc<CommunityExportData>('net.openfederation.community.export', {
    method: 'GET',
    params: { did },
  });
}

export async function suspendCommunity(did: string, reason?: string) {
  return xrpc<SuspendCommunityResponse>('net.openfederation.community.suspend', {
    body: { did, reason },
  });
}

export async function unsuspendCommunity(did: string) {
  return xrpc<UnsuspendCommunityResponse>('net.openfederation.community.unsuspend', {
    body: { did },
  });
}

export async function takedownCommunity(did: string, reason?: string) {
  return xrpc<TakedownCommunityResponse>('net.openfederation.community.takedown', {
    body: { did, reason },
  });
}

export async function transferCommunity(did: string) {
  return xrpc<CommunityTransferPackage>('net.openfederation.community.transfer', {
    body: { did },
  });
}
