/**
 * Type definitions for the OpenFederation SDK IIFE bundle (window.OpenFederation).
 *
 * When using the SDK via <script src="/sdk/v1.js">, all exports are available
 * on the global `OpenFederation` object. This file provides type information
 * for that global.
 *
 * Usage in TypeScript projects consuming the IIFE bundle:
 *
 *   /// <reference types="@open-federation/sdk/global" />
 *
 *   const ofd = OpenFederation.createClient({
 *     serverUrl: 'https://pds.openfederation.net',
 *     partnerKey: 'ofp_...',
 *   });
 */

declare namespace OpenFederation {
  // --- Types ---

  interface ClientConfig {
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

  interface User {
    did: string;
    handle: string;
    email: string;
    active: boolean;
  }

  interface RegisterOptions {
    handle: string;
    email: string;
    password: string;
  }

  interface LoginOptions {
    identifier: string;
    password: string;
  }

  interface FetchOptions {
    method?: 'GET' | 'POST';
    body?: Record<string, unknown>;
    params?: Record<string, string>;
  }

  interface Session {
    accessJwt: string;
    refreshJwt: string;
    user: User;
  }

  interface AuthProvider {
    getAccessToken(): Promise<string | null>;
    getUser(): Promise<User | null>;
    isAuthenticated(): boolean;
    onAuthChange(callback: (user: User | null) => void): () => void;
  }

  interface ATProtoLoginOptions {
    handle: string;
    redirectUri?: string;
    state?: string;
  }

  interface VerifiedSession {
    did: string;
    handle: string;
  }

  interface VerifyPdsTokenOptions {
    pdsUrl?: string;
    plcDirectoryUrl?: string;
    expectedDid?: string;
    timeoutMs?: number;
  }

  // --- Classes ---

  class OpenFederationClient implements AuthProvider {
    constructor(config: ClientConfig);
    register(opts: RegisterOptions): Promise<User>;
    login(opts: LoginOptions): Promise<User>;
    getUser(): Promise<User | null>;
    isAuthenticated(): boolean;
    getAccessToken(): Promise<string | null>;
    getSession(): Promise<Session | null>;
    onAuthChange(callback: (user: User | null) => void): () => void;
    logout(): Promise<void>;
    loginWithATProto(handleOrOpts: string | ATProtoLoginOptions): void;
    handleOAuthCallback(): Promise<User>;
    displayHandle(handle: string): string;
    fetch(nsid: string, opts?: FetchOptions): Promise<unknown>;
    destroy(): void;
  }

  class OpenFederationError extends Error {
    readonly status: number;
    readonly code: string;
    constructor(message: string, status: number, code: string);
  }

  class AuthenticationError extends OpenFederationError {
    constructor(message?: string);
  }

  class ValidationError extends OpenFederationError {
    constructor(message: string);
  }

  class ConflictError extends OpenFederationError {
    constructor(message?: string);
  }

  class RateLimitError extends OpenFederationError {
    constructor(message?: string);
  }

  class ForbiddenError extends OpenFederationError {
    constructor(message?: string);
  }

  // --- Functions ---

  function createClient(config: ClientConfig): OpenFederationClient;
  function displayHandle(handle: string, suffix?: string): string;
  function verifyPdsToken(accessToken: string, options?: VerifyPdsTokenOptions): Promise<VerifiedSession | null>;
  function waitForSDK(timeoutMs?: number): Promise<Record<string, unknown>>;

  // --- Constants ---

  const SDK_VERSION: string;
}
