import crypto from 'crypto';

const RESERVED_HANDLES = new Set([
  'admin', 'administrator', 'root', 'system', 'moderator', 'mod',
  'null', 'undefined', 'api', 'xrpc', 'health', 'status',
  'openfederation', 'atproto', 'bluesky', 'support', 'help',
  'official', 'security', 'staff', 'team', 'ops', 'operations',
  'abuse', 'contact', 'info', 'news', 'legal', 'privacy', 'tos',
  'trust', 'safety', 'bot', 'service', 'noreply', 'no-reply',
]);

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function normalizeHandle(handle: string): string {
  return handle.trim().toLowerCase();
}

export function isValidHandle(handle: string): boolean {
  if (handle.length < 3 || handle.length > 30) return false;
  if (handle.startsWith('-') || handle.endsWith('-')) return false;
  if (handle.includes('--')) return false;
  if (RESERVED_HANDLES.has(handle)) return false;
  return /^[a-z0-9-]+$/.test(handle);
}

export function isValidEmail(email: string): boolean {
  return /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/.test(email);
}

export function isStrongPassword(password: string): boolean {
  if (password.length < 10) return false;
  if (password.length > 128) return false;
  const hasLower = /[a-z]/.test(password);
  const hasUpper = /[A-Z]/.test(password);
  const hasDigit = /[0-9]/.test(password);
  const hasSpecial = /[^a-zA-Z0-9]/.test(password);
  const categoryCount = [hasLower, hasUpper, hasDigit, hasSpecial].filter(Boolean).length;
  return categoryCount >= 3;
}

export function passwordValidationMessage(): string {
  return 'Password must be 10-128 characters and contain at least 3 of: lowercase, uppercase, digit, special character';
}

/**
 * Generate a local-only PLC-format DID (not registered with any directory).
 * Used only for the bootstrap admin account which is a PDS operator,
 * not an AT Protocol participant. All real users get registered DIDs
 * via createUserIdentity().
 */
export function createLocalDid(): string {
  const rand = crypto.randomBytes(16);
  return `did:plc:${base32Encode(rand).substring(0, 24)}`;
}

export function generateInviteCode(): string {
  return crypto.randomBytes(12).toString('base64url');
}

/**
 * Validate a domain name for did:web usage.
 */
export function isValidDomain(domain: string): boolean {
  if (domain.length < 4 || domain.length > 253) return false;
  if (/[/:@\s#?\\]/.test(domain)) return false;
  if (!domain.includes('.')) return false;
  const labels = domain.split('.');
  return labels.every(label =>
    label.length >= 1 &&
    label.length <= 63 &&
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label)
  );
}

/**
 * Parse a Cookie header string into a key-value map.
 * No external dependency — handles standard cookie format.
 */
export function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!cookieHeader) return cookies;
  for (const pair of cookieHeader.split(';')) {
    const eqIdx = pair.indexOf('=');
    if (eqIdx === -1) continue;
    const key = pair.substring(0, eqIdx).trim();
    const val = pair.substring(eqIdx + 1).trim();
    if (key) cookies[key] = decodeURIComponent(val);
  }
  return cookies;
}

function base32Encode(buffer: Buffer): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  let bits = 0;
  let value = 0;
  let result = '';

  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      result += alphabet[(value >>> bits) & 0x1f];
    }
  }

  if (bits > 0) {
    result += alphabet[(value << (5 - bits)) & 0x1f];
  }

  return result;
}
