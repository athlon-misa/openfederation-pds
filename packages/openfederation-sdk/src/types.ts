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
  /**
   * A registration ticket minted by your backend with `createPartnerTicket`.
   * Required when your partner key has a ticket key registered; the account
   * is then approved and signed in at once. Without a ticket key, leave this
   * out: the account is created but must verify its email before it can
   * sign in (see `RegisterResult.emailVerificationRequired`).
   */
  ticket?: string;
}

/** What `register()` returns: the new user, and whether they still have to verify their email. */
export interface RegisterResult extends User {
  /**
   * True when the account was created without a session: the user must open
   * the link emailed to them, then sign in with `login()`.
   */
  emailVerificationRequired: boolean;
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

// ── Progressive-custody wallet provisioning ─────────

export type WalletChain = 'ethereum' | 'solana';
export type CustodyTier = 'custodial' | 'user_encrypted' | 'self_custody';

export interface ProvisionTier1Options {
  chain: WalletChain;
  label?: string;
}

export interface ProvisionTier2Options {
  chain: WalletChain;
  /** Passphrase used to wrap the generated mnemonic before it is uploaded. */
  passphrase: string;
  label?: string;
}

export interface ProvisionTier3Options {
  chain: WalletChain;
  label?: string;
}

export interface ProvisionResult {
  chain: WalletChain;
  walletAddress: string;
  custodyTier: CustodyTier;
  label: string | null;
  /** Tier 3 only: the raw mnemonic returned to the caller. */
  mnemonic?: string;
}

export interface GrantConsentOptions {
  dappOrigin: string;
  chain?: WalletChain;
  walletAddress?: string;
  /** How long the consent lasts once approved. Default 3600 (1 hour); the server caps it. */
  ttlSeconds?: number;
  /** Addresses (Solana: program ids) transactions may go to. Without it the consent signs messages only. */
  allowedContracts?: string[];
  /** Most value one transaction may move, in wei, as a decimal string. Without it no value may move. */
  maxValuePerTx?: string;
  /** Most value all transactions under the consent may move together, in wei. */
  maxTotalValue?: string;
}

export interface ConsentRequest {
  requestId: string;
  /** Page on the PDS where the user approves the request. Open it in a new window or tab. */
  approveUrl: string;
  /** When the request lapses if the user does not approve it. */
  expiresAt: string;
}

export interface ConsentRequestStatus {
  requestId: string;
  status: 'pending' | 'approved' | 'denied' | 'expired';
  dappOrigin: string;
  expiresAt: string;
  consentId?: string;
}

export interface ConsentGrant {
  id: string;
  dappOrigin: string;
  chain?: WalletChain | null;
  walletAddress?: string | null;
  allowedContracts?: string[];
  maxValuePerTx?: string;
  maxTotalValue?: string;
  spentValue?: string;
  grantedAt: string;
  expiresAt: string;
}

export interface WalletSignOptions {
  chain: WalletChain;
  walletAddress: string;
  message: string;
  /** Origin of the requesting dApp; defaults to `window.location.origin`. */
  dappOrigin?: string;
}

export interface WalletSignTxEthereumOptions {
  chain: 'ethereum';
  walletAddress: string;
  /** ethers v6 TransactionRequest. Must include chainId. */
  tx: Record<string, unknown> & { chainId: number | bigint | string };
  dappOrigin?: string;
}

export interface WalletSignTxSolanaOptions {
  chain: 'solana';
  walletAddress: string;
  /** base64 of Transaction.compileMessage().serialize(). */
  messageBase64: string;
  dappOrigin?: string;
}

export type WalletSignTransactionOptions = WalletSignTxEthereumOptions | WalletSignTxSolanaOptions;

export type WalletSignTransactionResult =
  | { chain: 'ethereum'; walletAddress: string; dappOrigin: string; signedTx: string }
  | { chain: 'solana'; walletAddress: string; dappOrigin: string; signature: string };

// ── Sign-In With OpenFederation ──────────────────────

export interface SiwofChallengeResponse {
  message: string;
  nonce: string;
  issuedAt: string;
  expirationTime: string;
  audience: string;
  chainIdCaip2: string;
}

export interface SiwofWalletProof {
  message: string;
  signature: string;
  chain: WalletChain;
  walletAddress: string;
  chainIdCaip2: string;
}

export interface SiwofAssertResponse {
  didToken: string;
  walletProof: SiwofWalletProof;
  did: string;
  audience: string;
}

export interface UpgradeTierOptions {
  chain: WalletChain;
  walletAddress: string;
  /** Target tier: 'user_encrypted' or 'self_custody'. Downgrades are unsupported. */
  newTier: 'user_encrypted' | 'self_custody';
  /** The caller's current account password. */
  currentPassword: string;
  /** New passphrase for wrapping the mnemonic at Tier 2. Required when newTier = 'user_encrypted'. */
  newPassphrase?: string;
  /**
   * The wallet's current Tier 2 passphrase. Required for Tier 2 → Tier 3: the
   * secret is unwrapped with it and returned before the server copy is deleted.
   */
  tier2Passphrase?: string;
  /** Current tier of the wallet, known by the client. SDK reads this from list endpoints. */
  currentTier: CustodyTier;
}

export interface UpgradeTierResult {
  chain: WalletChain;
  walletAddress: string;
  previousTier: string;
  newTier: 'user_encrypted' | 'self_custody';
  /** Present ONLY for custodial → self_custody. Raw private key bytes as base64. */
  exportedPrivateKeyBase64?: string;
  /**
   * Present ONLY for user_encrypted → self_custody: the unwrapped secret. After
   * this call it exists nowhere else; show it to the user to keep.
   */
  exportedSecret?: string;
  /** What `exportedSecret` is: a BIP-39 mnemonic, or a base64 raw private key. */
  exportedSecretKind?: 'mnemonic' | 'raw-private-key';
}

export interface SignInWithOpenFederationOptions {
  chain: WalletChain;
  walletAddress: string;
  /** Full dApp URL; the message's URI field and didToken `aud` both derive from this. */
  audience: string;
  /** Optional CAIP-2 chain ID (e.g. "eip155:137"). Defaults by chain. */
  chainId?: string;
  /** Optional prompt shown to the user in the wallet-sign dialog. */
  statement?: string;
  /** Optional resources the signature also attests to. */
  resources?: string[];
  /**
   * How to sign the challenge. Omit for Tier 1 (PDS signs). Provide a
   * WalletSession (from unlockTier2) or any object with signMessage(msg, chain)
   * — e.g. ethers.Wallet wrapped to expose that shape — for Tier 2/3.
   */
  signer?: { signMessage: (message: string, chain: WalletChain) => Promise<string> | string };
}

// ── Vault & Recovery ────────────────────────────────

export interface SecurityLevel {
  recoveryTier: number;
  /** Every tier is custodial: the PDS holds the rotation key (see pdsHoldsRotationKey). */
  tierName: 'custodial' | 'escrow-recorded' | 'key-exported';
  pdsHoldsRotationKey: boolean;
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
  /** The salt is not public; it comes with a full disclosure (`redeemGrant().commitmentSalt`). */
  commitment: { hash: string; schemaHash?: string; version?: string };
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
  /**
   * Salt of the attestation's public commitment; present only when the grant
   * covers the whole claim. sha256(`${salt}:${canonical claim JSON}`) equals
   * `verifyCommitment().commitment.hash`.
   */
  commitmentSalt?: string;
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

// ── Custodial Secrets ───────────────────────────────

export interface StoreCustodialSecretOptions {
  secretType: string;
  chain: string;
  encryptedBlob: string;
  walletAddress: string;
}

export interface CustodialSecret {
  secretType: string;
  chain: string;
  encryptedBlob: string;
  walletAddress: string;
  createdAt: string;
  updatedAt: string;
}

// ── Community discovery ─────────────────────────────

export interface DiscoverCommunitiesOptions {
  /** 1–100, default 50. */
  limit?: number;
  /** The `cursor` of the previous page. */
  cursor?: string;
  /** Case-insensitive text filter on handle, display name and description (at most 100 characters). */
  q?: string;
}

export interface DiscoveredCommunity {
  did: string;
  handle: string;
  /** The handle when the community has no display name. */
  displayName: string;
  /** Cut to 300 characters. */
  description: string;
  /** As reported by the community's home server. */
  memberCount: number;
  /** Base URL of the PDS that hosts the community. */
  pdsUrl: string;
  /**
   * Origin of the hosting server's dashboard, when it publishes one; the
   * community's page is `{webUrl}/communities/{did}`. Checked by the PDS to be
   * an http(s) origin; still check before building a link.
   */
  webUrl?: string;
  /** `local`: hosted on the server asked. `peer`: listed by a peer, not verified further. */
  source: 'local' | 'peer' | (string & {});
}

export interface DiscoveryPeerStatus {
  /** The peer's base URL. */
  url: string;
  status: 'ok' | 'failed' | (string & {});
  /** When ok: communities this peer contributed after deduplication. */
  communityCount?: number;
  /** When failed: `Timeout`, `Unreachable`, `BlockedUrl`, `HttpError`, `InvalidResponse` or `ResponseTooLarge`. */
  error?: string;
}

export interface DiscoverCommunitiesResult {
  communities: DiscoveredCommunity[];
  /** Present when there are more results. */
  cursor?: string;
  /** Every peer asked, and whether it answered. */
  peers: DiscoveryPeerStatus[];
}

// ── Activity timeline ───────────────────────────────

export interface UserTimelineOptions {
  /** 1–100, default 30. */
  limit?: number;
  /** The `cursor` of the previous page. */
  cursor?: string;
}

/** Which fields are present depends on the entry's kind. */
export interface ActivitySummary {
  handle?: string;
  role?: string;
  title?: string;
  name?: string;
  startsAt?: string;
  action?: string;
  targetCollection?: string;
  status?: string;
}

export interface ActivityEntry {
  /** Unique across communities; the tie-breaker in the sort order. */
  id: string;
  /** `member.joined`, `joinRequest.created`, `proposal.created`, `event.created`, `forum.thread.created`; skip kinds you do not know. */
  kind: string;
  /** Community DID. */
  community: string;
  /** Who did it; absent for an event, which the community publishes. */
  actor?: string;
  /** The record's at-uri, when there is one. */
  uri?: string;
  cid?: string;
  /** UTC with microseconds; the sort key, newest first. */
  createdAt: string;
  summary?: ActivitySummary;
}

export interface UserTimeline {
  entries: ActivityEntry[];
  /** Absent on the last page. */
  cursor?: string;
  /** Communities whose PDS did not answer: their activity is missing from this page. */
  unreachable: string[];
  /** Peer PDS URLs that could not be asked which communities the user belongs to there. */
  unreachablePeers: string[];
}
