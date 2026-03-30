/**
 * Pre-computed CORS origins — parsed once at startup.
 * Avoids re-splitting process.env.CORS_ORIGINS on every request.
 */

const origins = new Set(
  (process.env.CORS_ORIGINS || 'http://localhost:3001')
    .split(',')
    .map(o => o.trim())
    .filter(Boolean)
);

export function isAllowedStaticOrigin(origin: string): boolean {
  return origins.has(origin);
}
