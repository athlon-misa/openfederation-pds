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
