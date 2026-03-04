import type { ClientConfig, User, Session, RegisterOptions, LoginOptions, FetchOptions, SessionResponse, AuthProvider, ATProtoLoginOptions } from './types.js';
import { TokenManager } from './auth.js';
import { createStorage } from './storage.js';
import { displayHandle as displayHandleUtil, xrpcUrl } from './utils.js';
import { errorFromResponse, AuthenticationError } from './errors.js';

export class OpenFederationClient implements AuthProvider {
  private serverUrl: string;
  private partnerKey: string;
  private tokens: TokenManager;
  private autoRefresh: boolean;
  private authChangeListeners: Set<(user: User | null) => void> = new Set();

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
   * Register a new user via the partner API.
   * No invite code needed — user is auto-approved and logged in.
   */
  async register(opts: RegisterOptions): Promise<User> {
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

    window.location.href = url.toString();
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

    const url = `${this.serverUrl}/oauth/external/complete`;

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
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

  /**
   * Clean up timers and callbacks.
   */
  destroy(): void {
    this.tokens.destroy();
    this.authChangeListeners.clear();
  }

  /** Refresh the access token using the refresh token */
  private async doRefresh(): Promise<void> {
    const refreshJwt = this.tokens.getRefreshJwt();
    if (!refreshJwt) {
      this.tokens.clear();
      this.notifyAuthChange(null);
      return;
    }

    try {
      const url = xrpcUrl(this.serverUrl, 'com.atproto.server.refreshSession');
      const res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${refreshJwt}` },
      });

      if (!res.ok) {
        this.tokens.clear();
        this.notifyAuthChange(null);
        return;
      }

      const data: SessionResponse = await res.json();
      const user: User = {
        did: data.did,
        handle: data.handle,
        email: data.email,
        active: data.active ?? true,
      };

      this.tokens.setTokens(data.accessJwt, data.refreshJwt, user);
    } catch {
      // Network error during refresh — don't clear tokens, let the next request retry
    }
  }
}
