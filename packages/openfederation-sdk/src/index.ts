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
