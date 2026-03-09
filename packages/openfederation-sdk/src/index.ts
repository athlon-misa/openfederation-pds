export { OpenFederationClient } from './client.js';
export { verifyPdsToken } from './verify.js';
export { displayHandle } from './utils.js';
export {
  OpenFederationError,
  AuthenticationError,
  ValidationError,
  ConflictError,
  RateLimitError,
  ForbiddenError,
} from './errors.js';
export type {
  ATProtoLoginOptions,
  AuthProvider,
  ClientConfig,
  User,
  Session,
  RegisterOptions,
  LoginOptions,
  FetchOptions,
} from './types.js';
export type { VerifiedSession, VerifyPdsTokenOptions } from './verify.js';

import { OpenFederationClient } from './client.js';
import type { ClientConfig } from './types.js';

/** SDK version. Follows semver. */
export const SDK_VERSION = '0.1.0';

/**
 * Create an OpenFederation client instance.
 *
 * @example
 * ```ts
 * const ofd = createClient({
 *   serverUrl: 'https://pds.openfederation.net',
 *   partnerKey: 'ofp_abc123...',
 *   onAuthChange: (user) => updateUI(user),
 * });
 * ```
 */
export function createClient(config: ClientConfig): OpenFederationClient {
  return new OpenFederationClient(config);
}

/**
 * Returns a Promise that resolves when the OpenFederation SDK is available.
 * If the SDK is already loaded (i.e., this function exists), resolves immediately.
 *
 * This is primarily useful in the IIFE bundle context when loading the SDK
 * with `async` or `defer` attributes. If you can call this function, the SDK
 * is already loaded and this resolves immediately.
 *
 * For the recommended guard pattern when the SDK might not be loaded yet,
 * listen for the `openfederation:ready` DOM event instead.
 *
 * @param _timeoutMs - Unused (reserved for future use). The SDK resolves immediately since this function only exists if the SDK is loaded.
 * @returns Promise that resolves immediately
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function waitForSDK(_timeoutMs: number = 10000): Promise<Record<string, unknown>> {
  // If this function is being called, the SDK is already loaded.
  // In the IIFE context, `OpenFederation` is the global that holds all exports.
  // In ESM/CJS context, callers already have the module reference.
  const g = typeof globalThis !== 'undefined' ? globalThis : ({} as Record<string, unknown>);
  const sdk = (g as Record<string, unknown>).OpenFederation;
  return Promise.resolve(sdk as Record<string, unknown> || {});
}

// Fire a custom event when the IIFE bundle finishes loading.
// This allows pages that load the script with `async` or `defer` to detect readiness.
if (typeof document !== 'undefined') {
  try {
    document.dispatchEvent(new CustomEvent('openfederation:ready', { detail: { version: SDK_VERSION } }));
  } catch {
    // Swallow errors in non-browser environments (SSR, Node, etc.)
  }
}
