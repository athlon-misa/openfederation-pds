export interface ClientConfig {
  /** PDS server URL, e.g. "https://pds.openfederation.net" */
  serverUrl: string;
  /** Partner API key for registration (ofp_...) */
  partnerKey: string;
  /** Storage backend: 'local' (default), 'session', or 'memory' */
  storage?: 'local' | 'session' | 'memory';
  /** Prefix for storage keys (default: 'ofd_') */
  storagePrefix?: string;
  /** Auto-refresh access tokens before expiry (default: true) */
  autoRefresh?: boolean;
  /** Called when auth state changes (login, logout, token refresh failure) */
  onAuthChange?: (user: User | null) => void;
}

export interface User {
  did: string;
  handle: string;
  email: string;
  active: boolean;
}

export interface RegisterOptions {
  handle: string;
  email: string;
  password: string;
}

export interface LoginOptions {
  identifier: string;
  password: string;
}

export interface FetchOptions {
  method?: 'GET' | 'POST';
  body?: Record<string, unknown>;
  params?: Record<string, string>;
}

export interface Session {
  accessJwt: string;
  refreshJwt: string;
  user: User;
}

/**
 * Interface for third-party SDKs to consume OpenFederation auth.
 * The OpenFederationClient implements this — pass it as `authProvider`
 * to any SDK that needs authenticated requests.
 */
export interface AuthProvider {
  /** Get a valid access token, auto-refreshing if expired. */
  getAccessToken(): Promise<string | null>;
  /** Get the current user, or null if not authenticated. */
  getUser(): Promise<User | null>;
  /** Synchronous check for whether tokens exist. */
  isAuthenticated(): boolean;
  /** Subscribe to auth state changes. Returns an unsubscribe function. */
  onAuthChange(callback: (user: User | null) => void): () => void;
}

export interface ATProtoLoginOptions {
  /** ATProto handle (e.g. "alice.bsky.social") */
  handle: string;
  /** Where to redirect after auth. Defaults to current page URL. */
  redirectUri?: string;
  /** Opaque state for CSRF protection — passed through the OAuth flow. */
  state?: string;
}

/** Internal: shape of the register/login response from the PDS */
export interface SessionResponse {
  id?: string;
  did: string;
  handle: string;
  email: string;
  status?: string;
  accessJwt: string;
  refreshJwt: string;
  active: boolean;
}

// ── Wallet Linking ──────────────────────────────────

export interface WalletChallenge {
  challenge: string;
  expiresAt: string;
}

export interface WalletLink {
  chain: string;
  walletAddress: string;
  label: string | null;
  linkedAt: string;
}

export interface WalletResolution {
  did: string;
  handle: string;
}

export interface LinkWalletOptions {
  chain: 'ethereum' | 'solana';
  walletAddress: string;
  challenge: string;
  signature: string;
  label?: string;
}

// ── Vault & Recovery ────────────────────────────────

export interface SecurityLevel {
  recoveryTier: number;
  tierName: 'standard' | 'enhanced' | 'self-custodial';
  checklist: {
    passkey: boolean;
    recoveryEmail: boolean;
    vaultShares: boolean;
    escrowRegistered: boolean;
    keyExported: boolean;
  };
  upgradePath: string | null;
}

export interface VaultAuditEntry {
  id: string;
  userDid: string;
  action: string;
  actorDid?: string;
  shareIndex?: number;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface RegisterEscrowOptions {
  escrowProviderDid: string;
  escrowProviderName: string;
  verificationUrl?: string;
}

export interface InitiateRecoveryOptions {
  handle: string;
  email: string;
}

export interface CompleteRecoveryOptions {
  token: string;
  newPassword: string;
}

// ── Encrypted Attestations ──────────────────────────

export interface IssueAttestationOptions {
  communityDid: string;
  subjectDid: string;
  subjectHandle: string;
  type: 'membership' | 'role' | 'credential';
  claim: Record<string, unknown>;
  expiresAt?: string;
  visibility?: 'public' | 'private';
  accessPolicy?: Record<string, unknown>;
}

export interface AttestationResult {
  uri: string;
  cid: string;
  rkey: string;
  visibility?: string;
  commitment?: string;
}

export interface CommitmentVerification {
  commitment: { hash: string; schemaHash?: string };
  issuerDid: string;
  visibility: string;
  issuedAt?: string;
  revoked: boolean;
}

export interface DisclosureResult {
  encryptedDEK: string;
  ciphertext: string;
  iv: string;
  authTag: string;
}

export interface ViewingGrant {
  grantId: string;
  expiresAt: string;
}

export interface CreateViewingGrantOptions {
  communityDid: string;
  rkey: string;
  grantedToDid: string;
  expiresInMinutes?: number;
  grantedFields?: string[];
}

// ── Disclosure Proxy ────────────────────────────────

export interface GrantRedemption {
  sessionEncryptedPayload: { ciphertext: string; iv: string; authTag: string };
  sessionKey: string;
  expiresAt: string;
  watermarkId: string;
}

export interface GrantStatus {
  status: string;
  expiresAt: string;
  accessCount: number;
  lastAccessedAt?: string;
  createdAt: string;
}

export interface DisclosureAuditEntry {
  id: string;
  grantId?: string;
  attestationCommunityDid: string;
  attestationRkey: string;
  requesterDid: string;
  action: string;
  watermarkId?: string;
  createdAt: string;
}
