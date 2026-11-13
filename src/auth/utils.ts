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

export function generateInviteCode(): string {
  return crypto.randomBytes(12).toString('base64url');
}

