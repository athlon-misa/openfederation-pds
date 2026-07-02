/**
 * Pre-computed CORS origins — parsed once at startup.
 * Avoids re-splitting process.env.CORS_ORIGINS on every request.
 */

import { config } from '../config.js';

const origins = new Set(config.cors.origins);

export function isAllowedStaticOrigin(origin: string): boolean {
  return origins.has(origin);
}
