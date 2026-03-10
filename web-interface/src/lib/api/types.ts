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
  roles: ('admin' | 'moderator' | 'partner-manager' | 'auditor' | 'user')[];
}

// Account types
export interface RegisterResponse {
  id: string;
  handle: string;
  email: string;
  status: 'pending';
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

// Account list types
export interface AccountListItem {
  id: string;
  handle: string;
  email: string;
  did: string;
  status: string;
  roles: string[];
  createdAt: string;
  approvedAt: string | null;
}

export interface ListAccountsResponse {
  users: AccountListItem[];
  total: number;
  limit: number;
  offset: number;
}

// Invite list types
export interface InviteListItem {
  code: string;
  maxUses: number;
  usesCount: number;
  expiresAt: string | null;
  createdAt: string;
  createdByHandle: string;
  status: string;
}

export interface ListInvitesResponse {
  invites: InviteListItem[];
  total: number;
  limit: number;
  offset: number;
}

// Audit log types
export interface AuditEntry {
  id: string;
  action: string;
  actorId: string | null;
  actorHandle: string | null;
  targetId: string | null;
  meta: Record<string, unknown> | null;
  createdAt: string;
}

export interface ListAuditResponse {
  entries: AuditEntry[];
  total: number;
  limit: number;
  offset: number;
}

// Server config types
export interface ServerConfigResponse {
  service: string;
  version: string;
  hostname: string;
  inviteRequired: boolean;
  stats: {
    totalUsers: number;
    pendingUsers: number;
    approvedUsers: number;
    totalCommunities: number;
    activeCommunities: number;
    suspendedCommunities: number;
    totalInvites: number;
    activeInvites: number;
  };
}

// External login types
export interface ResolveExternalResponse {
  redirectUrl: string;
}

export interface ExternalCompleteResponse {
  did: string;
  handle: string;
  email: string;
  accessJwt: string;
  refreshJwt: string;
  active: boolean;
}

// Partner key types
export interface PartnerKeyListItem {
  id: string;
  keyPrefix: string;
  name: string;
  partnerName: string;
  permissions: string[];
  allowedOrigins: string[] | null;
  rateLimitPerHour: number;
  status: string;
  lastUsedAt: string | null;
  totalRegistrations: number;
  createdAt: string;
  createdBy: string | null;
  revokedAt: string | null;
}

export interface ListPartnerKeysResponse {
  keys: PartnerKeyListItem[];
}

export interface CreatePartnerKeyResponse {
  id: string;
  key: string;
  keyPrefix: string;
  name: string;
  partnerName: string;
  permissions: string[];
  allowedOrigins: string[] | null;
  rateLimitPerHour: number;
  status: string;
}

export interface RevokePartnerKeyResponse {
  id: string;
  status: string;
}

// Peer / federation types
export interface PeerInfo {
  hostname: string;
  serviceUrl: string;
  healthy: boolean;
  activeCommunities?: number;
}

export interface PeerCommunity {
  did: string;
  handle: string;
  didMethod: 'plc' | 'web';
  displayName: string;
  description: string;
  visibility: 'public' | 'private';
  joinPolicy: 'open' | 'approval';
  memberCount: number;
  createdAt: string;
  pdsUrl: string;
  pdsHostname: string;
}

export interface ListPeerCommunitiesResponse {
  communities: PeerCommunity[];
  peers: PeerInfo[];
  cachedAt: string;
}

export interface ListPeersResponse {
  self: { hostname: string; serviceUrl: string };
  peers: PeerInfo[];
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
