/**
 * Which PDS this dashboard talks to, decided when the dashboard *runs*, not
 * when it is built (#405). One prebuilt dashboard image then works for every
 * install: set `PDS_URL` on the container and restart.
 *
 * How the address reaches the browser:
 *  - `/runtime-config.js` (src/app/runtime-config.js/route.ts) is a tiny
 *    same-origin script, rendered per request from the server's environment,
 *    that sets `window.__OPENFEDERATION_DASHBOARD__ = { pdsUrl }`. A script
 *    file rather than an inline one, so a script CSP of 'self' allows it.
 *  - The root layout loads it with next/script `beforeInteractive`. Next's
 *    bootstrap runs those scripts, in order, before it hydrates or requires
 *    any page module, so module-level constants such as THIS_PDS see it. (A
 *    plain `<script src>` would not do: Next's own chunks are `async` and
 *    may run first.)
 *
 * Order of precedence:
 *  1. `PDS_URL`, read at runtime by the dashboard server;
 *  2. `NEXT_PUBLIC_PDS_URL`, inlined at build time (Railway and Nixpacks
 *     builds keep working unchanged);
 *  3. `http://localhost:3000`, the development default.
 *
 * Only plain http(s) addresses are accepted: no credentials, query or
 * fragment, and nothing the URL parser would have to rewrite, so the value
 * can never carry markup into the page.
 */

export const RUNTIME_CONFIG_GLOBAL = '__OPENFEDERATION_DASHBOARD__';
export const RUNTIME_CONFIG_PATH = '/runtime-config.js';
export const DEFAULT_PDS_URL = 'http://localhost:3000';

export interface RuntimeConfig {
  pdsUrl: string | null;
}

type Env = Record<string, string | undefined>;

export function normalizePdsUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username || url.password || url.search || url.hash) return null;
  const out = (url.origin + url.pathname).replace(/\/+$/, '');
  // Reject anything the parser rewrote (percent-encoded characters, odd
  // spellings): what is configured is exactly what is used.
  return out.toLowerCase() === trimmed.toLowerCase() ? out : null;
}

/** The address as the dashboard server sees it: PDS_URL, else the build-time value. */
export function serverPdsUrl(env: Env): string | null {
  return normalizePdsUrl(env.PDS_URL) ?? normalizePdsUrl(env.NEXT_PUBLIC_PDS_URL);
}

/** The address in the browser: the injected runtime config, else the build-time value, else the default. */
export function resolvePdsUrl(input: { injected: Partial<RuntimeConfig> | undefined; buildTime: string | undefined }): string {
  return normalizePdsUrl(input.injected?.pdsUrl) ?? normalizePdsUrl(input.buildTime) ?? DEFAULT_PDS_URL;
}

/** The body of /runtime-config.js. JSON with `<`, `>` and `&` escaped, so it is safe anywhere. */
export function runtimeConfigScript(env: Env): string {
  const config: RuntimeConfig = { pdsUrl: serverPdsUrl(env) };
  const json = JSON.stringify(config).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
  return `window[${JSON.stringify(RUNTIME_CONFIG_GLOBAL)}]=Object.freeze(${json});\n`;
}

/**
 * The configured address, or null when none is (development default aside).
 * In the browser it reads the injected config; on the dashboard server, the
 * environment at runtime. `process.env.NEXT_PUBLIC_PDS_URL` is spelled out so
 * Next inlines it at build time.
 */
export function configuredPdsUrl(): string | null {
  const buildTime = process.env.NEXT_PUBLIC_PDS_URL;
  if (typeof window !== 'undefined') {
    const injected = (window as unknown as Record<string, Partial<RuntimeConfig> | undefined>)[RUNTIME_CONFIG_GLOBAL];
    return normalizePdsUrl(injected?.pdsUrl) ?? normalizePdsUrl(buildTime);
  }
  return normalizePdsUrl(process.env.PDS_URL) ?? normalizePdsUrl(buildTime);
}

/** The address every API call uses. */
export function pdsUrl(): string {
  return configuredPdsUrl() ?? DEFAULT_PDS_URL;
}
