/**
 * Production configuration rules that fail silently if nobody checks them.
 * Called at start-up next to the secret checks in src/server/index.ts.
 *
 *  - OAUTH_SIGNING_KEY: without it the OAuth signing key is generated at
 *    start, so every restart invalidates every OAuth token and two instances
 *    sign with different keys. Fatal, like the other secrets.
 *  - REDIS_URL: without it OAuth replay protection lives in one process's
 *    memory, which is only sound for a single instance. Warning.
 *  - DB_SSL: off means database traffic is clear text. Fine on this machine
 *    or a platform's private network (Railway, Fly and GCP name those
 *    "*.internal") or a single-label name such as a Docker Compose service
 *    ("postgres"); otherwise a warning.
 */

/** Generates an ES256 private key as a single-line JWK for OAUTH_SIGNING_KEY. */
export const OAUTH_KEY_COMMAND: readonly string[] = [
  'node', '-e',
  "const k=require('crypto').generateKeyPairSync('ec',{namedCurve:'P-256'}).privateKey.export({format:'jwk'});" +
  "console.log(JSON.stringify({...k,alg:'ES256',kid:'oauth-signing-key'}))",
];

export interface ProductionCheckInput {
  isProduction: boolean;
  oauth: { enabled: boolean; signingKey: string; redisUrl: string };
  database: { ssl: boolean; host: string };
}

export interface ProductionProblems {
  fatal: string[];
  warnings: string[];
}

function isLocalOrPrivateNetworkHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || h.startsWith('127.') || h.startsWith('/') || h.endsWith('.internal')
    // A single-label name (`postgres`) is only resolvable on a private network:
    // a Docker Compose service, as in deploy/appliance (#405).
    || /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(h) && !/^\d+$/.test(h);
}

function shellQuote(arg: string): string {
  return /^[A-Za-z0-9_.\/-]+$/.test(arg) ? arg : `"${arg.replace(/(["\\$`])/g, '\\$1')}"`;
}

export function productionConfigProblems(input: ProductionCheckInput): ProductionProblems {
  const problems: ProductionProblems = { fatal: [], warnings: [] };
  if (!input.isProduction) return problems;

  if (input.oauth.enabled && !input.oauth.signingKey) {
    problems.fatal.push(
      'OAUTH_SIGNING_KEY is not set. Without it the OAuth signing key changes on every restart, ' +
      'which invalidates every OAuth token, and instances sign with different keys. Generate one with:\n' +
      `  ${OAUTH_KEY_COMMAND.map(shellQuote).join(' ')}\n` +
      'or set OAUTH_ENABLED=false if this instance does not offer ATProto OAuth.',
    );
  }
  if (input.oauth.enabled && !input.oauth.redisUrl) {
    problems.warnings.push(
      'REDIS_URL is not set: OAuth replay protection is kept in this process\'s memory. ' +
      'That is only sound with a single instance; set REDIS_URL before running more than one.',
    );
  }
  if (!input.database.ssl && !isLocalOrPrivateNetworkHost(input.database.host)) {
    problems.warnings.push(
      `DB_SSL is off and the database (${input.database.host}) is not on this machine or a private ` +
      'platform network: database traffic, passwords included, is not encrypted. Set DB_SSL=true.',
    );
  }
  return problems;
}
