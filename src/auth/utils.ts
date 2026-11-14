import { config } from '../config.js';
import crypto from 'crypto';
import { normalizeHandle } from './credential-rules.js';

export {
  normalizeEmail, normalizeHandle, isValidHandle, isWellFormedHandle, isValidEmail, isStrongPassword,
  passwordValidationMessage, createLocalDid, isValidDomain, parseCookies,
} from './credential-rules.js';

/**
 * A handle as typed at sign-in, matched to how accounts store it here: the
 * short form. AT Protocol clients send the full handle (`elena` plus this
 * server's domain), so this server's own suffix is dropped; any other domain
 * is left alone and simply won't match.
 */
export function localHandle(identifier: string): string {
  const handle = normalizeHandle(identifier);
  const suffix = config.handleSuffix.toLowerCase();
  return suffix && handle.endsWith(suffix) && handle.length > suffix.length
    ? handle.slice(0, -suffix.length)
    : handle;
}

/** The stand-in an external account gets when its own handle can't be used (`plc-` + its PLC id). */
const EXTERNAL_PLACEHOLDER = /^plc-[a-z2-7]{24}$/;

/**
 * A stored handle as responses give it: the full AT Protocol handle, the name
 * plus this server's handle domain (`elena` → `elena.openfederation.net`),
 * matching the `at://` name in the account's DID document (#411).
 *
 * Accounts and communities here store the short form. Anything that is not a
 * short name of this server is returned unchanged: a handle that already has
 * a domain (an external account's own handle, a remote member's), a DID, or
 * the placeholder an external account gets when its own handle can't be used
 * (that name was never issued here, so this server's domain is not added).
 */
export function fullHandle(stored: string): string;
export function fullHandle(stored: string | null | undefined): string | null;
export function fullHandle(stored: string | null | undefined): string | null {
  if (!stored) return stored ?? null;
  if (!/^[a-z0-9-]+$/.test(stored) || EXTERNAL_PLACEHOLDER.test(stored)) return stored;
  // Exactly as identities are registered in PLC (`at://` + name + suffix).
  return `${stored}${config.handleSuffix}`;
}

export function generateInviteCode(): string {
  return crypto.randomBytes(12).toString('base64url');
}

