// Auth types
export interface SessionResponse {
  did: string;
  handle: string;
  email: string;
  accessJwt: string;
  refreshJwt: string;
  active: boolean;
}

export interface GetSessionResponse {
  did: string;
  handle: string;
  email: string;
  active: boolean;
  status: 'pending' | 'approved' | 'rejected' | 'disabled';
  roles: ('admin' | 'moderator' | 'user')[];
}

// Account types
export interface RegisterResponse {
  id: string;
  handle: string;
  email: string;
  status: 'pending';
}

// Admin types
export interface PendingUser {
  id: string;
  handle: string;
  email: string;
  created_at: string;
}

export interface ListPendingResponse {
  users: PendingUser[];
  limit: number;
  offset: number;
}

// Invite types
export interface InviteResponse {
  code: string;
  maxUses: number;
  expiresAt: string | null;
}

// Community types
export interface CommunityPlcResponse {
  did: string;
  handle: string;
  didMethod: 'plc';
  primaryRotationKey: string;
  message: string;
}

export interface CommunityWebResponse {
  did: string;
  handle: string;
  didMethod: 'web';
  didDocument: Record<string, unknown>;
  instructions: string;
}

export type CommunityCreateResponse = CommunityPlcResponse | CommunityWebResponse;

export interface CommunityListItem {
  did: string;
  handle: string;
  didMethod: 'plc' | 'web';
  displayName: string;
  description: string;
  createdAt: string;
  role?: 'owner' | 'moderator' | 'member';
}

export interface ListCommunitiesResponse {
  communities: CommunityListItem[];
  limit: number;
  offset: number;
}

// Community status type (AT Protocol compliance)
export type CommunityStatus = 'active' | 'suspended' | 'takendown';

// Community detail type (from community.get)
export interface CommunityDetail {
  did: string;
  handle: string;
  didMethod: 'plc' | 'web';
  displayName: string;
  description: string;
  visibility: 'public' | 'private';
  joinPolicy: 'open' | 'approval';
  memberCount: number;
  createdAt: string;
  status: CommunityStatus;
  statusReason: string | null;
  isOwner: boolean;
  isMember: boolean;
  joinRequestStatus: 'pending' | 'approved' | 'rejected' | null;
}

// Community list item for explore/listAll (extends CommunityListItem with extra fields)
export interface CommunityListAllItem extends CommunityListItem {
  visibility: 'public' | 'private';
  joinPolicy: 'open' | 'approval';
  memberCount: number;
  status?: CommunityStatus;
  isMember: boolean;
  joinRequestStatus: 'pending' | 'approved' | 'rejected' | null;
}

export interface ListAllCommunitiesResponse {
  communities: CommunityListAllItem[];
  total: number;
  limit: number;
  offset: number;
}

export interface JoinCommunityResponse {
  status: 'joined' | 'pending';
}

export interface LeaveCommunityResponse {
  success: boolean;
}

export interface CommunityMember {
  did: string;
  handle: string;
  role: string;
  joinedAt: string;
}

export interface ListMembersResponse {
  members: CommunityMember[];
  total: number;
  limit: number;
  offset: number;
}

export interface JoinRequest {
  id: string;
  userId: string;
  userDid: string;
  handle: string;
  status: string;
  createdAt: string;
}

export interface ListJoinRequestsResponse {
  requests: JoinRequest[];
  total: number;
  limit: number;
  offset: number;
}

export interface ResolveJoinRequestResponse {
  status: 'approved' | 'rejected';
}

export interface UpdateCommunityResponse {
  success: boolean;
}

// Community export type
export interface CommunityExportData {
  $type: 'net.openfederation.community.export';
  exportedAt: string;
  exportedBy: string;
  community: {
    did: string;
    handle: string;
    didMethod: string;
    status: string;
  };
  stats: {
    totalRecords: number;
    memberCount: number;
    collections: number;
  };
  collections: Record<string, Array<{ rkey: string; cid: string; record: Record<string, unknown> }>>;
}

// Community moderation response types
export interface SuspendCommunityResponse {
  did: string;
  status: 'suspended';
  reason: string | null;
}

export interface UnsuspendCommunityResponse {
  did: string;
  status: 'active';
}

export interface TakedownCommunityResponse {
  did: string;
  status: 'takendown';
  reason: string | null;
}

// Community transfer type
export interface CommunityTransferPackage {
  $type: 'net.openfederation.community.transfer';
  transferToken: string;
  transferExpiresAt: string;
  exportedAt: string;
  sourcePds: string;
  community: {
    did: string;
    handle: string;
    didMethod: string;
  };
  stats: {
    totalRecords: number;
    memberCount: number;
    collections: number;
  };
  collections: Record<string, Array<{ rkey: string; cid: string; record: Record<string, unknown> }>>;
  instructions: string;
}

// API error type
export interface ApiError {
  error: string;
  message: string;
}

// API result discriminated union
export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; error: string; message: string };
