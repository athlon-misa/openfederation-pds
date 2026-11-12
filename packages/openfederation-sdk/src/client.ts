import type {
  ClientConfig, User, Session, RegisterOptions, RegisterResult, LoginOptions, FetchOptions,
  SessionResponse, AuthProvider, ATProtoLoginOptions,
  WalletChallenge, WalletLink, WalletResolution, LinkWalletOptions,
  SecurityLevel, VaultAuditEntry, RegisterEscrowOptions,
  InitiateRecoveryOptions, CompleteRecoveryOptions,
  IssueAttestationOptions, AttestationResult, CommitmentVerification,
  DisclosureResult, CreateViewingGrantOptions, ViewingGrant,
  GrantRedemption, GrantStatus, DisclosureAuditEntry,
  StoreCustodialSecretOptions, CustodialSecret,
  WalletChain, ProvisionTier1Options, ProvisionTier2Options, ProvisionTier3Options,
  ProvisionResult, GrantConsentOptions, ConsentGrant, ConsentRequest, ConsentRequestStatus, WalletSignOptions,
  WalletSignTransactionOptions, WalletSignTransactionResult,
  SiwofChallengeResponse, SiwofAssertResponse, SignInWithOpenFederationOptions,
  UpgradeTierOptions, UpgradeTierResult,
  DiscoverCommunitiesOptions, DiscoverCommunitiesResult, UserTimelineOptions, UserTimeline,
} from './types.js';
import { TokenManager } from './auth.js';
import { createStorage } from './storage.js';
import { displayHandle as displayHandleUtil, xrpcUrl } from './utils.js';
import { errorFromResponse, AuthenticationError } from './errors.js';
import { provisionTier2, provisionTier3 } from './wallet/provision.js';
import { sessionFromWrappedSecret } from './wallet/unlock.js';
import { WalletSession } from './wallet/wallet-session.js';
import { createSolanaSigner } from './wallet/solana-adapter.js';
import { normalizeEvmTxForWire } from './wallet/tx-normalize.js';
import { upgradeToTier as upgradeToTierFlow } from './wallet/upgrade.js';
import { coordinatedRefresh } from './refresh.js';
import { newLoginVerifier, takeLoginVerifier } from './login-binding.js';

/** How long to wait before retrying a refresh that failed for a transient reason. */
const REFRESH_RETRY_MS = 30_000;

export class OpenFederationClient implements AuthProvider {
  private serverUrl: string;
  private partnerKey: string;
  private tokens: TokenManager;
  private autoRefresh: boolean;
  private authChangeListeners: Set<(user: User | null) => void> = new Set();
  private refreshPromise: Promise<void> | null = null;

  constructor(config: ClientConfig) {
    this.serverUrl = config.serverUrl.replace(/\/$/, '');
    this.partnerKey = config.partnerKey;
    this.autoRefresh = config.autoRefresh !== false;

    if (config.onAuthChange) {
      this.authChangeListeners.add(config.onAuthChange);
    }

    const storage = createStorage(config.storage || 'local');
    this.tokens = new TokenManager(storage, config.storagePrefix || 'ofd_');

    if (this.autoRefresh) {
      this.tokens.setRefreshCallback(() => this.doRefresh());
    }
  }

  private notifyAuthChange(user: User | null): void {
    for (const cb of this.authChangeListeners) {
      cb(user);
    }
  }

  /**
   * Register a new user via the partner API. No invite code needed.
   *
   * With a `ticket` from your backend the user is approved and signed in.
   * Without one (a partner key with no ticket key) the account is created but
   * not signed in: `emailVerificationRequired` is true, and the user signs in
   * with `login()` after opening the link emailed to them.
   */
  async register(opts: RegisterOptions): Promise<RegisterResult> {
    const url = xrpcUrl(this.serverUrl, 'net.openfederation.partner.register');

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Partner-Key': this.partnerKey,
      },
      body: JSON.stringify({
        handle: opts.handle,
        email: opts.email,
        password: opts.password,
        ...(opts.ticket ? { ticket: opts.ticket } : {}),
      }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw errorFromResponse(res.status, body);
    }

    const data: Partial<SessionResponse> & { did: string; handle: string; email: string; emailVerificationRequired?: boolean } = await res.json();

    // No session came back: the account exists but has to verify its email
    // first. Nothing is stored and nobody is signed in.
    if (!data.accessJwt || !data.refreshJwt) {
      return { did: data.did, handle: data.handle, email: data.email, active: false, emailVerificationRequired: true };
    }

    const user: User = {
      did: data.did,
      handle: data.handle,
      email: data.email,
      active: data.active ?? true,
    };

    this.tokens.setTokens(data.accessJwt, data.refreshJwt, user);
    this.notifyAuthChange(user);
    return { ...user, emailVerificationRequired: false };
  }

  /**
   * Log in with handle/email and password via standard ATProto createSession.
   */
  async login(opts: LoginOptions): Promise<User> {
    const url = xrpcUrl(this.serverUrl, 'com.atproto.server.createSession');

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        identifier: opts.identifier,
        password: opts.password,
      }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw errorFromResponse(res.status, body);
    }

    const data: SessionResponse = await res.json();
    const user: User = {
      did: data.did,
      handle: data.handle,
      email: data.email,
      active: data.active ?? true,
    };

    this.tokens.setTokens(data.accessJwt, data.refreshJwt, user);
    this.notifyAuthChange(user);
    return user;
  }

  /**
   * Get the current user from storage, or null if not logged in.
   */
  async getUser(): Promise<User | null> {
    return this.tokens.getUser();
  }

  /**
   * Check if the user is currently authenticated (has tokens).
   */
  isAuthenticated(): boolean {
    return this.tokens.hasTokens();
  }

  /**
   * Get a valid access JWT, auto-refreshing if expired or about to expire.
   * Returns null if not authenticated.
   */
  async getAccessToken(): Promise<string | null> {
    if (!this.tokens.hasTokens()) return null;
    if (this.tokens.isTokenExpired(60)) {
      await this.doRefresh();
    }
    return this.tokens.getAccessJwt();
  }

  /**
   * Get the full session (tokens + user), auto-refreshing if needed.
   * Returns null if not authenticated.
   */
  async getSession(): Promise<Session | null> {
    await this.getAccessToken();
    const accessJwt = this.tokens.getAccessJwt();
    const refreshJwt = this.tokens.getRefreshJwt();
    const user = this.tokens.getUser();
    if (!accessJwt || !refreshJwt || !user) return null;
    return { accessJwt, refreshJwt, user };
  }

  /**
   * Subscribe to auth state changes (login, logout, token refresh failure).
   * Returns an unsubscribe function.
   */
  onAuthChange(callback: (user: User | null) => void): () => void {
    this.authChangeListeners.add(callback);
    return () => { this.authChangeListeners.delete(callback); };
  }

  /**
   * Log out and invalidate the session on the server.
   */
  async logout(): Promise<void> {
    const refreshJwt = this.tokens.getRefreshJwt();

    if (refreshJwt) {
      try {
        const url = xrpcUrl(this.serverUrl, 'com.atproto.server.deleteSession');
        await fetch(url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${refreshJwt}` },
        });
      } catch {
        // Ignore network errors during logout
      }
    }

    this.tokens.clear();
    this.notifyAuthChange(null);
  }

  /**
   * Initiate ATProto OAuth login by redirecting to the PDS `/auth/atproto` endpoint.
   * For existing Bluesky/ATProto users who want to log in with their home PDS.
   *
   * Accepts a handle string (backwards compatible) or an options object.
   * This is synchronous — it navigates the browser, no fetch needed.
   */
  loginWithATProto(handleOrOpts: string | ATProtoLoginOptions): void {
    const opts: ATProtoLoginOptions = typeof handleOrOpts === 'string'
      ? { handle: handleOrOpts }
      : handleOrOpts;

    const redirectUri = opts.redirectUri || window.location.href;

    const url = new URL(`${this.serverUrl}/auth/atproto`);
    url.searchParams.set('handle', opts.handle);
    url.searchParams.set('redirect_uri', redirectUri);
    if (opts.state) {
      url.searchParams.set('state', opts.state);
    }

    // Bind this login to this tab. A random secret stays here; only its hash
    // goes to the PDS, which ties it to the one-time code it issues at the
    // end. The code is then useless to anyone who does not hold the secret,
    // in particular to a victim who is sent someone else's callback link.
    const verifier = newLoginVerifier();
    if (verifier) {
      url.searchParams.set('code_challenge', verifier.challenge);
    }

    window.location.href = url.toString();
  }

  /**
   * Inject an existing session for server-side use.
   * Call when you already have valid tokens (e.g. from an iron-session cookie)
   * and don't need to go through the login flow.
   *
   * @example
   * const sdk = createClient({ serverUrl, partnerKey, storage: 'memory' });
   * sdk.loginWithExternalSession(session.accessToken, session.refreshToken, {
   *   did: session.did, handle: session.handle, email: session.email, active: true,
   * });
   * // sdk is now fully usable for any authenticated call
   */
  loginWithExternalSession(accessJwt: string, refreshJwt: string, user: User): void {
    this.tokens.setTokens(accessJwt, refreshJwt, user);
    this.notifyAuthChange(user);
  }

  /**
   * Handle the OAuth callback after ATProto login redirect.
   * Call this on the callback page to complete the login flow.
   *
   * Exchanges the temporary code (from query params) for local JWT tokens
   * via POST /oauth/external/complete.
   */
  async handleOAuthCallback(): Promise<User> {
    const params = new URLSearchParams(window.location.search);

    // Check for error from failed OAuth callback
    const error = params.get('error');
    if (error) {
      throw new AuthenticationError(`ATProto login failed: ${error}`);
    }

    const code = params.get('code');
    if (!code) {
      throw new AuthenticationError('No authorization code in callback URL');
    }

    // Only finish a login this tab started. Without its verifier the code in
    // the URL is somebody else's: redeeming it would sign this browser in as
    // whoever sent the link.
    const codeVerifier = takeLoginVerifier();
    if (!codeVerifier) {
      throw new AuthenticationError('This login was not started in this tab. Please sign in again.');
    }

    const url = `${this.serverUrl}/oauth/external/complete`;

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, codeVerifier }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw errorFromResponse(res.status, body);
    }

    const data: SessionResponse = await res.json();
    const user: User = {
      did: data.did,
      handle: data.handle,
      email: data.email,
      active: data.active ?? true,
    };

    this.tokens.setTokens(data.accessJwt, data.refreshJwt, user);
    this.notifyAuthChange(user);
    return user;
  }

  /**
   * Strip domain suffix from a handle for display.
   * "alice.openfederation.net" → "alice"
   */
  displayHandle(handle: string): string {
    return displayHandleUtil(handle);
  }

  /**
   * Make an authenticated XRPC request.
   */
  async fetch(nsid: string, opts?: FetchOptions): Promise<unknown> {
    const method = opts?.method || 'GET';
    const url = xrpcUrl(this.serverUrl, nsid, method === 'GET' ? opts?.params : undefined);

    const accessJwt = this.tokens.getAccessJwt();
    if (!accessJwt) {
      throw new AuthenticationError('Not authenticated');
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessJwt}`,
    };

    let body: string | undefined;
    if (method === 'POST' && opts?.body) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(opts.body);
    }

    const res = await globalThis.fetch(url, { method, headers, body });

    if (res.status === 401) {
      // Try a refresh and retry once
      await this.doRefresh();
      const newToken = this.tokens.getAccessJwt();
      if (!newToken) throw new AuthenticationError('Session expired');

      headers.Authorization = `Bearer ${newToken}`;
      const retry = await globalThis.fetch(url, { method, headers, body });

      if (!retry.ok) {
        const retryBody = await retry.json().catch(() => ({}));
        throw errorFromResponse(retry.status, retryBody);
      }
      return retry.json();
    }

    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      throw errorFromResponse(res.status, errBody);
    }

    return res.json();
  }

  // ── Wallet Linking ──────────────────────────────────

  /**
   * Get a challenge string for wallet linking. The challenge must be signed
   * by the wallet's private key and passed to `linkWallet()`.
   */
  async getWalletLinkChallenge(chain: string, walletAddress: string): Promise<WalletChallenge> {
    return this.fetch('net.openfederation.identity.getWalletLinkChallenge', {
      method: 'GET',
      params: { chain, walletAddress },
    }) as Promise<WalletChallenge>;
  }

  /**
   * Link a wallet to the authenticated user's account.
   * Requires a signed challenge from `getWalletLinkChallenge()`.
   */
  async linkWallet(opts: LinkWalletOptions): Promise<{ success: boolean; chain: string; walletAddress: string; label: string | null }> {
    return this.fetch('net.openfederation.identity.linkWallet', {
      method: 'POST',
      body: opts as unknown as Record<string, unknown>,
    }) as Promise<{ success: boolean; chain: string; walletAddress: string; label: string | null }>;
  }

  /**
   * Unlink a wallet from the authenticated user's account by label.
   */
  async unlinkWallet(label: string): Promise<{ success: boolean }> {
    return this.fetch('net.openfederation.identity.unlinkWallet', {
      method: 'POST',
      body: { label },
    }) as Promise<{ success: boolean }>;
  }

  /**
   * List all wallets linked to the authenticated user's account.
   */
  async listWalletLinks(): Promise<{ walletLinks: WalletLink[] }> {
    return this.fetch('net.openfederation.identity.listWalletLinks', {
      method: 'GET',
    }) as Promise<{ walletLinks: WalletLink[] }>;
  }

  /**
   * Resolve a wallet address to an ATProto DID.
   * Public endpoint — no authentication required.
   */
  async resolveWallet(chain: string, walletAddress: string): Promise<WalletResolution> {
    // A plain request, not `this.fetch`: that one refuses to run without a
    // session, and this lookup is for anyone, signed in or not.
    const res = await fetch(xrpcUrl(this.serverUrl, 'net.openfederation.identity.resolveWallet', { chain, walletAddress }));
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw errorFromResponse(res.status, body);
    }
    return res.json() as Promise<WalletResolution>;
  }

  // ── Communities & Activity ──────────────────────────

  /**
   * Public communities on this server and on the peers it federates with,
   * deduplicated by DID. Each says where it lives (`pdsUrl`, `source`);
   * `peers` says which peers answered. A peer that fails never fails the call.
   * Public endpoint — no authentication required.
   */
  async discoverCommunities(opts: DiscoverCommunitiesOptions = {}): Promise<DiscoverCommunitiesResult> {
    const params: Record<string, string> = {};
    if (opts.limit !== undefined) params.limit = String(opts.limit);
    if (opts.cursor) params.cursor = opts.cursor;
    if (opts.q) params.q = opts.q;
    // A plain request, not `this.fetch`: discovery is for anyone, signed in or not.
    const res = await globalThis.fetch(xrpcUrl(this.serverUrl, 'net.openfederation.community.discover', params));
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw errorFromResponse(res.status, body);
    }
    return res.json() as Promise<DiscoverCommunitiesResult>;
  }

  /**
   * The signed-in user's timeline: recent activity across every community
   * they belong to, on this server and on its peers, newest first.
   * `unreachable` / `unreachablePeers` name what did not answer in time; the
   * page is built from what did.
   */
  async getUserTimeline(opts: UserTimelineOptions = {}): Promise<UserTimeline> {
    const params: Record<string, string> = {};
    if (opts.limit !== undefined) params.limit = String(opts.limit);
    if (opts.cursor) params.cursor = opts.cursor;
    return this.fetch('net.openfederation.activity.getUserTimeline', {
      method: 'GET',
      params,
    }) as Promise<UserTimeline>;
  }

  // ── Vault & Recovery ────────────────────────────────

  /**
   * Get the current user's security/recovery tier and checklist.
   */
  async getSecurityLevel(): Promise<SecurityLevel> {
    return this.fetch('net.openfederation.account.getSecurityLevel', {
      method: 'GET',
    }) as Promise<SecurityLevel>;
  }

  /**
   * Request the release of a Shamir secret share for key recovery.
   */
  async requestShareRelease(): Promise<{ share: string }> {
    return this.fetch('net.openfederation.vault.requestShareRelease', {
      method: 'POST',
    }) as Promise<{ share: string }>;
  }

  /**
   * Record an escrow provider for share 3 of the rotation key. The share stays
   * on the PDS (`shareStoredHere: true`): no transfer to the provider exists yet.
   */
  async registerEscrow(opts: RegisterEscrowOptions): Promise<{ success: boolean; recoveryTier: number; escrowProviderDid: string; shareStoredHere: boolean }> {
    return this.fetch('net.openfederation.vault.registerEscrow', {
      method: 'POST',
      body: opts as unknown as Record<string, unknown>,
    }) as Promise<{ success: boolean; recoveryTier: number; escrowProviderDid: string; shareStoredHere: boolean }>;
  }

  /**
   * Export the account's PLC rotation key (secp256k1, base64): the user's own
   * backup, enough to sign PLC operations and move without the PDS's help.
   * The PDS keeps its copy (custodial). Needs a fresh identity verification
   * per export.
   */
  async exportRecoveryKey(): Promise<{ rotationKey: string; recoveryTier: number; pdsHoldsRotationKey: boolean }> {
    return this.fetch('net.openfederation.vault.exportRecoveryKey', {
      method: 'POST',
    }) as Promise<{ rotationKey: string; recoveryTier: number; pdsHoldsRotationKey: boolean }>;
  }

  /**
   * Get the vault audit log showing share access and recovery events.
   */
  async getVaultAuditLog(limit?: number): Promise<{ entries: VaultAuditEntry[] }> {
    return this.fetch('net.openfederation.vault.auditLog', {
      method: 'GET',
      params: limit ? { limit: String(limit) } : undefined,
    }) as Promise<{ entries: VaultAuditEntry[] }>;
  }

  /**
   * Initiate account recovery (no auth required — user is locked out).
   * Sends a recovery email with a token.
   */
  async initiateRecovery(opts: InitiateRecoveryOptions): Promise<{ success: boolean }> {
    const url = `${this.serverUrl}/xrpc/net.openfederation.account.initiateRecovery`;
    const res = await globalThis.fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(opts),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw errorFromResponse(res.status, body);
    return body as { success: boolean };
  }

  /**
   * Complete account recovery with token and new password (no auth required).
   */
  async completeRecovery(opts: CompleteRecoveryOptions): Promise<{ success: boolean }> {
    const url = `${this.serverUrl}/xrpc/net.openfederation.account.completeRecovery`;
    const res = await globalThis.fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(opts),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw errorFromResponse(res.status, body);
    return body as { success: boolean };
  }

  // ── Attestations ────────────────────────────────────

  /**
   * Issue a signed attestation for a community member.
   * Supports public and private (encrypted) attestations.
   */
  async issueAttestation(opts: IssueAttestationOptions): Promise<AttestationResult> {
    return this.fetch('net.openfederation.community.issueAttestation', {
      method: 'POST',
      body: opts as unknown as Record<string, unknown>,
    }) as Promise<AttestationResult>;
  }

  /**
   * Verify a commitment hash for a private attestation without revealing content.
   */
  async verifyCommitment(communityDid: string, rkey: string): Promise<CommitmentVerification> {
    return this.fetch('net.openfederation.attestation.verifyCommitment', {
      method: 'GET',
      params: { communityDid, rkey },
    }) as Promise<CommitmentVerification>;
  }

  /**
   * Request disclosure of a private attestation's encrypted content.
   */
  async requestDisclosure(communityDid: string, rkey: string, purpose?: string): Promise<DisclosureResult> {
    return this.fetch('net.openfederation.attestation.requestDisclosure', {
      method: 'POST',
      body: { communityDid, rkey, ...(purpose && { purpose }) },
    }) as Promise<DisclosureResult>;
  }

  /**
   * Create a time-limited viewing grant for a private attestation.
   */
  async createViewingGrant(opts: CreateViewingGrantOptions): Promise<ViewingGrant> {
    return this.fetch('net.openfederation.attestation.createViewingGrant', {
      method: 'POST',
      body: opts as unknown as Record<string, unknown>,
    }) as Promise<ViewingGrant>;
  }

  // ── Disclosure Proxy ────────────────────────────────

  /**
   * Redeem a viewing grant to access a private attestation's content.
   * Returns a session-encrypted payload with a watermark for audit.
   */
  async redeemGrant(grantId: string): Promise<GrantRedemption> {
    return this.fetch('net.openfederation.disclosure.redeemGrant', {
      method: 'POST',
      body: { grantId },
    }) as Promise<GrantRedemption>;
  }

  /**
   * Check the status and access count of a viewing grant.
   */
  async getGrantStatus(grantId: string): Promise<GrantStatus> {
    return this.fetch('net.openfederation.disclosure.grantStatus', {
      method: 'GET',
      params: { grantId },
    }) as Promise<GrantStatus>;
  }

  /**
   * Revoke a viewing grant, preventing further access.
   */
  async revokeGrant(grantId: string): Promise<{ success: boolean }> {
    return this.fetch('net.openfederation.disclosure.revokeGrant', {
      method: 'POST',
      body: { grantId },
    }) as Promise<{ success: boolean }>;
  }

  /**
   * Get the disclosure audit log for a community's attestations.
   */
  async getDisclosureAuditLog(communityDid: string, rkey?: string, limit?: number): Promise<{ entries: DisclosureAuditEntry[] }> {
    const params: Record<string, string> = { communityDid };
    if (rkey) params.rkey = rkey;
    if (limit) params.limit = String(limit);
    return this.fetch('net.openfederation.disclosure.auditLog', {
      method: 'GET',
      params,
    }) as Promise<{ entries: DisclosureAuditEntry[] }>;
  }

  // ── Custodial Secrets ───────────────────────────────

  /**
   * Store (upsert) an encrypted custodial secret for one wallet.
   * The blob is opaque — the PDS never decrypts it.
   * Idempotent per wallet: calling again with the same chain and wallet address
   * replaces that wallet's entry. Other wallets on the chain are untouched.
   */
  async storeCustodialSecret(opts: StoreCustodialSecretOptions): Promise<{ success: boolean; secretId: string }> {
    return this.fetch('net.openfederation.vault.storeCustodialSecret', {
      method: 'POST',
      body: opts as unknown as Record<string, unknown>,
    }) as Promise<{ success: boolean; secretId: string }>;
  }

  /**
   * Retrieve the encrypted custodial secret for a wallet.
   * Pass `walletAddress` to say which wallet; it is required when the account
   * has more than one wallet with a stored secret on the chain.
   * Throws a 404 error if no secret exists.
   */
  async getCustodialSecret(chain: string, walletAddress?: string): Promise<CustodialSecret> {
    return this.fetch('net.openfederation.vault.getCustodialSecret', {
      method: 'GET',
      params: walletAddress ? { chain, walletAddress } : { chain },
    }) as Promise<CustodialSecret>;
  }

  // ── Progressive-custody wallets ──────────────────────

  /** Exposes the new wallet provisioning / signing APIs under a namespace. */
  readonly wallet = {
    /**
     * Provision a Tier 1 (custodial) wallet. The PDS generates the key,
     * encrypts it at rest, and links the address to the caller's DID.
     * Returns the new wallet's public address. The caller never sees the
     * private key — Tier 1 keys live entirely on the server until upgraded.
     */
    createTier1: async (opts: ProvisionTier1Options): Promise<ProvisionResult> => {
      const res = await this.fetch('net.openfederation.wallet.provision', {
        method: 'POST',
        body: { chain: opts.chain, label: opts.label },
      }) as ProvisionResult;
      return res;
    },

    /**
     * Provision a Tier 2 (user-encrypted) wallet: the SDK generates a BIP-39
     * mnemonic in the browser, wraps it with the user's passphrase, uploads
     * the opaque blob, and links the derived address to the DID via the
     * existing challenge-response flow. The PDS never sees the mnemonic.
     */
    createTier2: async (opts: ProvisionTier2Options): Promise<ProvisionResult> => {
      return provisionTier2(
        {
          getChallenge: (chain, walletAddress) =>
            this.getWalletLinkChallenge(chain, walletAddress),
          linkWallet: (o) =>
            this.linkWallet(o as LinkWalletOptions),
          storeCustodialSecret: (o) =>
            this.storeCustodialSecret(o as StoreCustodialSecretOptions),
        },
        opts
      );
    },

    /**
     * Provision a Tier 3 (self-custody) wallet. The SDK generates a mnemonic
     * locally, links the derived address, and returns the mnemonic to the
     * caller — who must store it themselves. Nothing beyond the public
     * binding is retained by the PDS.
     */
    createTier3: async (opts: ProvisionTier3Options): Promise<ProvisionResult> => {
      return provisionTier3(
        {
          getChallenge: (chain, walletAddress) =>
            this.getWalletLinkChallenge(chain, walletAddress),
          linkWallet: (o) =>
            this.linkWallet(o as LinkWalletOptions),
          storeCustodialSecret: async () => { /* unused on Tier 3 */ },
        },
        opts
      );
    },

    /**
     * Unlock a Tier 2 wallet with its passphrase. Returns an in-memory
     * `WalletSession` that signs client-side. A wallet created at Tier 2
     * holds a mnemonic and can sign for any chain derived from it; a wallet
     * upgraded from Tier 1 holds a single key and signs for its own chain.
     * Pass `walletAddress` when the account has several wallets on the chain.
     */
    unlockTier2: async (opts: { chain: WalletChain; passphrase: string; walletAddress?: string }): Promise<WalletSession> => {
      const secret = await this.getCustodialSecret(opts.chain, opts.walletAddress);
      return sessionFromWrappedSecret(secret.encryptedBlob, opts.passphrase, opts.chain);
    },

    /**
     * Sign a message with a Tier 1 wallet via the PDS. Requires an active
     * consent the user approved (`requestConsent()`). Returns a chain-native signature.
     */
    sign: async (opts: WalletSignOptions): Promise<{ signature: string; chain: string; walletAddress: string; dappOrigin: string }> => {
      const dappOrigin = opts.dappOrigin
        ?? (typeof globalThis !== 'undefined' && (globalThis as any).location
          ? (globalThis as any).location.origin
          : undefined);
      if (!dappOrigin) {
        throw new Error('dappOrigin is required (no window.location available in this environment)');
      }
      return this.fetch('net.openfederation.wallet.sign', {
        method: 'POST',
        body: {
          chain: opts.chain,
          walletAddress: opts.walletAddress,
          message: opts.message,
          dappOrigin,
        },
      }) as Promise<{ signature: string; chain: string; walletAddress: string; dappOrigin: string }>;
    },

    /**
     * Ask the user to let this dApp have the PDS sign with a Tier 1 wallet.
     * Nothing is granted yet: open `approveUrl` (a page on the PDS) for the
     * user, then `waitForConsent(requestId)`. The consent names what it
     * covers: give `allowedContracts` (and value limits) to sign transactions.
     */
    requestConsent: async (opts: GrantConsentOptions): Promise<ConsentRequest> => {
      return this.fetch('net.openfederation.wallet.requestConsent', {
        method: 'POST',
        body: opts as unknown as Record<string, unknown>,
      }) as Promise<ConsentRequest>;
    },

    /** Where a consent request stands. */
    getConsentRequest: async (requestId: string): Promise<ConsentRequestStatus> => {
      return this.fetch('net.openfederation.wallet.getConsentRequest', {
        method: 'GET',
        params: { requestId },
      }) as Promise<ConsentRequestStatus>;
    },

    /**
     * Poll a consent request until the user approves or declines it, or it
     * lapses. Resolves with the final status.
     */
    waitForConsent: async (requestId: string, opts: { intervalMs?: number; timeoutMs?: number } = {}): Promise<ConsentRequestStatus> => {
      const interval = opts.intervalMs ?? 2000;
      const deadline = Date.now() + (opts.timeoutMs ?? 10 * 60 * 1000);
      for (;;) {
        const status = await this.wallet.getConsentRequest(requestId);
        if (status.status !== 'pending' || Date.now() >= deadline) return status;
        await new Promise((resolve) => setTimeout(resolve, interval));
      }
    },

    /** Revoke a consent grant by id, or by origin + optional wallet scope. */
    revokeConsent: async (opts: { id?: string; dappOrigin?: string; chain?: WalletChain; walletAddress?: string }): Promise<{ revoked: number }> => {
      return this.fetch('net.openfederation.wallet.revokeConsent', {
        method: 'POST',
        body: opts as unknown as Record<string, unknown>,
      }) as Promise<{ revoked: number }>;
    },

    /** List all active (unrevoked, unexpired) consent grants for the user. */
    listConsents: async (): Promise<{ consents: ConsentGrant[] }> => {
      return this.fetch('net.openfederation.wallet.listConsents', {
        method: 'GET',
      }) as Promise<{ consents: ConsentGrant[] }>;
    },

    /**
     * Upgrade a wallet's custody tier without changing its on-chain address.
     * Supported transitions: 1→2, 1→3, 2→3. The caller's current password
     * is required for every transition; a new passphrase is additionally
     * required when going to Tier 2.
     */
    upgradeToTier: async (opts: UpgradeTierOptions): Promise<UpgradeTierResult> => {
      if (opts.currentTier === 'self_custody') {
        throw new Error('Already at Tier 3 (self-custody); nothing to upgrade');
      }
      const res = await upgradeToTierFlow(
        {
          retrieveForUpgrade: (o) =>
            this.fetch('net.openfederation.wallet.retrieveForUpgrade', {
              method: 'POST',
              body: o as unknown as Record<string, unknown>,
            }) as Promise<{ privateKeyBase64: string; exportFormat: string }>,
          finalizeTierChange: (o) =>
            this.fetch('net.openfederation.wallet.finalizeTierChange', {
              method: 'POST',
              body: o as unknown as Record<string, unknown>,
            }) as Promise<{ previousTier: string; newTier: string }>,
          getCustodialSecret: (o) => this.getCustodialSecret(o.chain, o.walletAddress),
        },
        {
          chain: opts.chain,
          walletAddress: opts.walletAddress,
          newTier: opts.newTier,
          currentPassword: opts.currentPassword,
          newPassphrase: opts.newPassphrase,
          tier2Passphrase: opts.tier2Passphrase,
          currentTier: opts.currentTier,
        }
      );
      return {
        chain: res.chain,
        walletAddress: res.walletAddress,
        previousTier: res.previousTier,
        newTier: res.newTier,
        exportedPrivateKeyBase64: res.exportedPrivateKeyBase64,
        exportedSecret: res.exportedSecret,
        exportedSecretKind: res.exportedSecretKind,
      };
    },

    /**
     * Sign a blockchain transaction with a Tier 1 wallet via the PDS. For
     * Tier 2 and Tier 3 wallets, sign client-side using an unlocked
     * `WalletSession` (Tier 2) or your own keys (Tier 3) — this endpoint
     * will refuse non-Tier-1 wallets.
     */
    signTransaction: async (opts: WalletSignTransactionOptions): Promise<WalletSignTransactionResult> => {
      const dappOrigin = opts.dappOrigin
        ?? (typeof globalThis !== 'undefined' && (globalThis as any).location
          ? (globalThis as any).location.origin
          : undefined);
      if (!dappOrigin) {
        throw new Error('dappOrigin is required (no window.location available in this environment)');
      }
      const body: Record<string, unknown> = {
        chain: opts.chain,
        walletAddress: opts.walletAddress,
        dappOrigin,
      };
      if (opts.chain === 'ethereum') {
        body.tx = normalizeEvmTxForWire(opts.tx);
      } else {
        body.messageBase64 = opts.messageBase64;
      }
      return this.fetch('net.openfederation.wallet.signTransaction', {
        method: 'POST',
        body,
      }) as Promise<WalletSignTransactionResult>;
    },

    /**
     * Return an ethers v6 Signer bound to the given wallet address.
     *
     * For Tier 2 wallets, the caller must supply an unlocked `session`
     * (from `unlockTier2`); signing happens client-side.
     *
     * For Tier 1 wallets, leave `session` unset — signing routes to the
     * PDS with the active consent grant. Note Tier 1 signing happens
     * asynchronously via fetch; compatible with ethers.Signer's async API.
     */
    asEthersSigner: async (opts: { walletAddress: string; session?: import('./wallet/wallet-session.js').WalletSession }) => {
      const { createEthersSigner } = await import('./wallet/ethers-adapter.js');
      return createEthersSigner(this, opts.walletAddress, opts.session);
    },

    /**
     * Return a lightweight Solana signer compatible with common
     * `@solana/web3.js` transaction-signing call-sites.
     */
    asSolanaSigner: (opts: { walletAddress: string; session?: import('./wallet/wallet-session.js').WalletSession }) => {
      return createSolanaSigner(this, opts.walletAddress, opts.session);
    },
  };

  /**
   * Sign-In With OpenFederation (SIWOF).
   *
   * Runs the full dApp sign-in flow in one call: issue a CAIP-122 challenge,
   * sign it with the named wallet, and have the PDS mint an offline-
   * verifiable didToken + walletProof. A dApp backend verifies both without
   * calling OpenFederation (see `verifySignInAssertion` for the primitives).
   *
   * Tier dispatch:
   *   - Tier 2/3: pass `signer` (a WalletSession from unlockTier2, or any
   *     object exposing `signMessage(message, chain)`). The signature is
   *     produced client-side.
   *   - Tier 1: omit `signer`. Each sign call routes through the PDS with
   *     the active dApp consent grant (must be granted separately first).
   */
  async signInWithOpenFederation(opts: SignInWithOpenFederationOptions): Promise<SiwofAssertResponse> {
    const challenge = await this.fetch('net.openfederation.identity.signInChallenge', {
      method: 'POST',
      body: {
        chain: opts.chain,
        walletAddress: opts.walletAddress,
        audience: opts.audience,
        ...(opts.chainId ? { chainId: opts.chainId } : {}),
        ...(opts.statement ? { statement: opts.statement } : {}),
        ...(opts.resources ? { resources: opts.resources } : {}),
      },
    }) as SiwofChallengeResponse;

    let walletSignature: string;
    if (opts.signer) {
      const s = await opts.signer.signMessage(challenge.message, opts.chain);
      walletSignature = s;
    } else {
      const res = await this.wallet.sign({
        chain: opts.chain,
        walletAddress: opts.walletAddress,
        message: challenge.message,
        dappOrigin: opts.audience,
      });
      walletSignature = res.signature;
    }

    return this.fetch('net.openfederation.identity.signInAssert', {
      method: 'POST',
      body: {
        chain: opts.chain,
        walletAddress: opts.walletAddress,
        message: challenge.message,
        walletSignature,
      },
    }) as Promise<SiwofAssertResponse>;
  }

  /**
   * Vanilla-JS drop-in: renders a "Sign in with OpenFederation" button into
   * the given DOM element. For React apps, prefer `<SignInWithOpenFederation>`
   * from `@open-federation/react`.
   *
   * @example
   * ```html
   * <div id="of-signin"></div>
   * <script src="/sdk/v1.js"></script>
   * <script>
   *   const client = OpenFederation.createClient({ serverUrl, partnerKey });
   *   client.mountSignInButton(document.getElementById('of-signin'), {
   *     chain: 'ethereum',
   *     audience: window.location.origin,
   *     onSuccess: (assertion) => fetch('/api/login', {
   *       method: 'POST', body: JSON.stringify(assertion),
   *     }),
   *   });
   * </script>
   * ```
   */
  mountSignInButton(
    target: Element,
    opts: {
      chain: 'ethereum' | 'solana';
      audience?: string;
      walletAddress?: string;
      statement?: string;
      label?: string;
      onSuccess: (assertion: SiwofAssertResponse) => void;
      onError?: (err: Error) => void;
    }
  ): { destroy: () => void } {
    const doc = target.ownerDocument;
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.textContent = opts.label ?? 'Sign in with OpenFederation';
    btn.setAttribute('data-openfederation-signin', '');
    Object.assign(btn.style, {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: '0.5rem',
      padding: '0.625rem 1rem',
      border: '1px solid rgba(0,0,0,0.1)',
      borderRadius: '0.5rem',
      background: '#111',
      color: '#fff',
      fontWeight: '600',
      cursor: 'pointer',
    });

    const originalLabel = btn.textContent;
    const setBusy = (busy: boolean) => {
      btn.disabled = busy;
      btn.style.opacity = busy ? '0.6' : '1';
      btn.textContent = busy ? 'Signing…' : originalLabel;
    };

    const handleClick = async () => {
      if (btn.disabled) return;
      setBusy(true);
      try {
        let walletAddress = opts.walletAddress;
        if (!walletAddress) {
          const list = await this.listWalletLinks();
          const match = list.walletLinks.find((w) => w.chain === opts.chain);
          if (!match) throw new Error(`No wallet on chain "${opts.chain}" for this account`);
          walletAddress = match.walletAddress;
        }
        const audience = opts.audience
          ?? (typeof (globalThis as any).location !== 'undefined'
            ? (globalThis as any).location.origin
            : undefined);
        if (!audience) throw new Error('audience is required');
        const assertion = await this.signInWithOpenFederation({
          chain: opts.chain,
          walletAddress,
          audience,
          statement: opts.statement,
        });
        opts.onSuccess(assertion);
      } catch (err) {
        if (opts.onError) opts.onError(err as Error);
        else throw err;
      } finally {
        setBusy(false);
      }
    };

    btn.addEventListener('click', handleClick);
    target.appendChild(btn);

    return {
      destroy: () => {
        btn.removeEventListener('click', handleClick);
        if (btn.parentNode) btn.parentNode.removeChild(btn);
      },
    };
  }

  /**
   * Clean up timers and callbacks.
   */
  destroy(): void {
    this.tokens.destroy();
    this.authChangeListeners.clear();
  }

  /** Refresh the access token using the refresh token */
  private async doRefresh(): Promise<void> {
    // Deduplicate concurrent refresh calls to prevent token reuse detection
    // from revoking all sessions (the PDS rotates refresh tokens on each use)
    if (this.refreshPromise) return this.refreshPromise;

    this.refreshPromise = this.executeRefresh();
    try {
      await this.refreshPromise;
    } finally {
      this.refreshPromise = null;
    }
  }

  private async executeRefresh(): Promise<void> {
    const outcome = await coordinatedRefresh({
      tokens: this.tokens,
      lockName: `openfederation-sdk-refresh:${this.serverUrl}`,
      doFetch: (refreshJwt) => fetch(xrpcUrl(this.serverUrl, 'com.atproto.server.refreshSession'), {
        method: 'POST',
        headers: { Authorization: `Bearer ${refreshJwt}` },
      }),
    });

    if (outcome === 'signed-out') {
      this.notifyAuthChange(null);
    } else if (outcome === 'retry-later') {
      // The session is intact; the server or the network was not. Try again shortly.
      this.tokens.scheduleRetry(REFRESH_RETRY_MS);
    }
  }
}
