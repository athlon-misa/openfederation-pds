import type { ClientConfig, User, Session, RegisterOptions, LoginOptions, FetchOptions, SessionResponse } from './types.js';
import { TokenManager } from './auth.js';
import { createStorage } from './storage.js';
import { displayHandle as displayHandleUtil, xrpcUrl } from './utils.js';
import { errorFromResponse, AuthenticationError } from './errors.js';

export class OpenFederationClient {
  private serverUrl: string;
  private partnerKey: string;
  private tokens: TokenManager;
  private autoRefresh: boolean;
  private onAuthChange?: (user: User | null) => void;

  constructor(config: ClientConfig) {
    this.serverUrl = config.serverUrl.replace(/\/$/, '');
    this.partnerKey = config.partnerKey;
    this.autoRefresh = config.autoRefresh !== false;
    this.onAuthChange = config.onAuthChange;

    const storage = createStorage(config.storage || 'local');
    this.tokens = new TokenManager(storage, config.storagePrefix || 'ofd_');

    if (this.autoRefresh) {
      this.tokens.setRefreshCallback(() => this.doRefresh());
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
    this.onAuthChange?.(user);
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
    this.onAuthChange?.(user);
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
   * Get the current access JWT, or null if not authenticated.
   */
  getAccessToken(): string | null {
    return this.tokens.getAccessJwt();
  }

  /**
   * Get the full session (tokens + user), or null if not authenticated.
   */
  getSession(): Session | null {
    const accessJwt = this.tokens.getAccessJwt();
    const refreshJwt = this.tokens.getRefreshJwt();
    const user = this.tokens.getUser();
    if (!accessJwt || !refreshJwt || !user) return null;
    return { accessJwt, refreshJwt, user };
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
    this.onAuthChange?.(null);
  }

  /**
   * Initiate ATProto OAuth login by redirecting to the PDS authorization endpoint.
   * For existing Bluesky/ATProto users who want to log in with their home PDS.
   */
  async loginWithATProto(handle: string): Promise<void> {
    const url = xrpcUrl(this.serverUrl, 'net.openfederation.account.resolveExternal', {
      handle,
    });

    const res = await fetch(url, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw errorFromResponse(res.status, body);
    }

    const data: { authUrl: string } = await res.json();
    window.location.href = data.authUrl;
  }

  /**
   * Handle the OAuth callback after ATProto login redirect.
   * Call this on the callback page to complete the login flow.
   */
  async handleOAuthCallback(): Promise<User> {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');

    if (!code) {
      throw new AuthenticationError('No authorization code in callback URL');
    }

    const url = xrpcUrl(this.serverUrl, 'net.openfederation.account.resolveExternal', {
      code,
    });

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
    this.onAuthChange?.(user);
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
    this.onAuthChange = undefined;
  }

  /** Refresh the access token using the refresh token */
  private async doRefresh(): Promise<void> {
    const refreshJwt = this.tokens.getRefreshJwt();
    if (!refreshJwt) {
      this.tokens.clear();
      this.onAuthChange?.(null);
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
        this.onAuthChange?.(null);
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
