/**
 * Pre-computed security headers — built once at import time.
 * Avoids per-request string concatenation and NODE_ENV checks.
 */

import type { Response } from 'express';

const IS_PRODUCTION = process.env.NODE_ENV === 'production';

const STATIC_HEADERS: [string, string][] = [
  ['X-Content-Type-Options', 'nosniff'],
  ['X-Frame-Options', 'DENY'],
  ['X-XSS-Protection', '0'],
  ['Referrer-Policy', 'strict-origin-when-cross-origin'],
  ['Permissions-Policy', 'camera=(), microphone=(), geolocation=()'],
  ['Content-Security-Policy', "default-src 'none'; script-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'"],
];

if (IS_PRODUCTION) {
  STATIC_HEADERS.push(['Strict-Transport-Security', 'max-age=63072000; includeSubDomains']);
}

export function setSecurityHeaders(res: Response): void {
  for (const [name, value] of STATIC_HEADERS) {
    res.setHeader(name, value);
  }
}
