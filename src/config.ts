import dotenv from 'dotenv';

dotenv.config();

const INSECURE_JWT_DEFAULTS = ['dev-secret-change-me', 'change_me', ''];

/**
 * Parse CHAIN_ADAPTERS env var.
 * Format: "eip155:137=https://polygon-rpc.com,eip155:1=https://eth-rpc.com"
 * Returns array of { chainId, rpcUrl } entries.
 */
function parseChainAdapters(raw: string): Array<{ chainId: string; rpcUrl: string }> {
  if (!raw.trim()) return [];
  return raw.split(',').map(entry => {
    const [chainId, ...rpcParts] = entry.trim().split('=');
    const rpcUrl = rpcParts.join('='); // rejoin in case URL contains '='
    return { chainId: chainId.trim(), rpcUrl: rpcUrl.trim() };
  }).filter(e => e.chainId && e.rpcUrl);
}

const jwtSecret = process.env.AUTH_JWT_SECRET || '';

function parseTrustProxy(val: string | undefined): string | number | boolean {
  if (!val) return 1;
  if (val === 'true') return true;
  if (val === 'false') return false;
  const num = parseInt(val, 10);
  if (!isNaN(num)) return num;
  return val;
}

const pdsHostname = process.env.PDS_HOSTNAME || 'pds.openfederation.net';

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),

  // Database configuration
  database: {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    database: process.env.DB_NAME || 'openfederation_pds',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || '',
    ssl: process.env.DB_SSL === 'true',
    sslRejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false',
    maxPoolSize: parseInt(process.env.DB_MAX_POOL_SIZE || '20', 10),
    idleTimeoutMs: parseInt(process.env.DB_IDLE_TIMEOUT_MS || '30000', 10),
    connectionTimeoutMs: parseInt(process.env.DB_CONNECTION_TIMEOUT_MS || '5000', 10),
    statementTimeoutMs: parseInt(process.env.DB_STATEMENT_TIMEOUT_MS || '60000', 10),
  },

  // PDS configuration
  pds: {
    hostname: pdsHostname,
    serviceUrl: process.env.PDS_SERVICE_URL || 'https://pds.openfederation.net',
    // Inbound service-auth `aud` claim. Default: did:web of this PDS.
    serviceDid: process.env.PDS_SERVICE_DID?.trim() || `did:web:${pdsHostname}`,
  },

  // PLC directory
  plc: {
    directoryUrl: process.env.PLC_DIRECTORY_URL || 'http://localhost:2582',
  },

  // Handle suffix for did:plc communities
  handleSuffix: process.env.HANDLE_SUFFIX || '.openfederation.net',

  // Auth configuration
  auth: {
    jwtSecret,
    jwtSecretIsInsecure: INSECURE_JWT_DEFAULTS.includes(jwtSecret) || jwtSecret.length < 32,
    accessTokenTtl: process.env.ACCESS_TOKEN_TTL || '15m',
    refreshTokenTtl: process.env.REFRESH_TOKEN_TTL || '30d',
    inviteRequired: process.env.INVITE_REQUIRED !== 'false',
    bootstrapAdminEmail: process.env.BOOTSTRAP_ADMIN_EMAIL || '',
    bootstrapAdminHandle: process.env.BOOTSTRAP_ADMIN_HANDLE || '',
    bootstrapAdminPassword: process.env.BOOTSTRAP_ADMIN_PASSWORD || '',
  },

  // Key encryption secret for encrypting recovery keys at rest
  keyEncryptionSecret: process.env.KEY_ENCRYPTION_SECRET || '',

  // Partner API configuration
  partners: {
    enabled: process.env.PARTNER_API_ENABLED !== 'false',
    defaultRateLimit: parseInt(process.env.PARTNER_DEFAULT_RATE_LIMIT || '100', 10),
  },

  // ActivityPub configuration
  activitypub: {
    enabled: process.env.ACTIVITYPUB_ENABLED !== 'false',
  },

  // Federation / peer PDS discovery
  federation: {
    enabled: process.env.FEDERATION_PEERS_ENABLED !== 'false',
    peerUrls: (process.env.PEER_PDS_URLS || '')
      .split(',')
      .map(u => u.trim())
      .filter(Boolean)
      .filter(u => u !== (process.env.PDS_SERVICE_URL || '')), // exclude self
    cacheTtlMs: parseInt(process.env.FEDERATION_CACHE_TTL_MS || '300000', 10), // 5 min
    webUiUrl: process.env.WEB_UI_URL || '',
  },

  // Blob storage configuration
  blob: {
    storage: (process.env.BLOB_STORAGE || 'local') as 'local' | 's3',
    localPath: process.env.BLOB_STORAGE_PATH || './data/blobs',
    maxSize: parseInt(process.env.BLOB_MAX_SIZE || '1048576', 10), // 1MB default
    allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
    s3Bucket: process.env.BLOB_S3_BUCKET || '',
    s3Region: process.env.BLOB_S3_REGION || 'us-east-1',
    s3Endpoint: process.env.BLOB_S3_ENDPOINT || '',
    s3AccessKeyId: process.env.BLOB_S3_ACCESS_KEY_ID || '',
    s3SecretAccessKey: process.env.BLOB_S3_SECRET_ACCESS_KEY || '',
  },

  // Export scheduler configuration
  exportScheduler: {
    enabled: process.env.EXPORT_SCHEDULER_ENABLED === 'true',
    checkIntervalMs: parseInt(process.env.EXPORT_CHECK_INTERVAL_MS || '300000', 10), // 5 min
  },

  // OAuth configuration
  oauth: {
    enabled: process.env.OAUTH_ENABLED !== 'false',
    dpopSecret: process.env.OAUTH_DPOP_SECRET || '',
    signingKey: process.env.OAUTH_SIGNING_KEY || '',  // ES256 private key as JWK JSON
    trustedClients: (process.env.OAUTH_TRUSTED_CLIENTS || '').split(',').filter(Boolean),
    redisUrl: process.env.REDIS_URL || '',
  },

  // Email configuration
  /**
   * What an unverified email blocks (#83). The operator's decision, because an
   * open-source PDS serves closed single-user instances and open registration
   * alike:
   *   off                nothing sent, nothing gated
   *   advisory (default) verification emails sent, state surfaced, nothing gated
   *   require-for-write  unverified accounts read and log in, but cannot act
   *   require-for-login  unverified local accounts cannot create sessions
   * An unrecognized value falls back to advisory with a loud warning: a typo
   * must not silently lock users out, and equally must not silently disable
   * verification the operator thought was on.
   */
  emailVerification: {
    policy: (() => {
      const v = process.env.EMAIL_VERIFICATION_POLICY || 'advisory';
      if (v === 'off' || v === 'advisory' || v === 'require-for-write' || v === 'require-for-login') return v;
      console.warn(`WARNING: EMAIL_VERIFICATION_POLICY "${v}" is not recognized; using "advisory".`);
      return 'advisory';
    })() as 'off' | 'advisory' | 'require-for-write' | 'require-for-login',
  },
  email: {
    enabled: process.env.SMTP_HOST ? true : false,
    host: process.env.SMTP_HOST || '',
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: process.env.SMTP_SECURE === 'true',
    user: process.env.SMTP_USER || '',
    password: process.env.SMTP_PASSWORD || '',
    from: process.env.SMTP_FROM || 'noreply@openfederation.net',
  },

  // Chain adapter configuration for on-chain proof verification
  chains: {
    adapters: parseChainAdapters(process.env.CHAIN_ADAPTERS || ''),
  },

  // Express trust proxy configuration (for rate limiting and req.ip with proxies)
  trustProxy: parseTrustProxy(process.env.EXPRESS_TRUST_PROXY),

  // Node environment
  env: {
    nodeEnv: process.env.NODE_ENV || 'development',
    isProduction: process.env.NODE_ENV === 'production',
  },

  // CORS origins for non-XRPC paths (web UI, OAuth). XRPC uses wildcard.
  cors: {
    origins: (process.env.CORS_ORIGINS || 'http://localhost:3001')
      .split(',')
      .map(o => o.trim())
      .filter(Boolean),
  },

  // Per-endpoint rate limits (see src/server/index.ts limiters)
  rateLimits: {
    // Every request, per IP, per minute. Configurable for the same reason the
    // others are: it is the only limiter that applies to *all* traffic, so a
    // deployment behind a shared egress IP — or a test suite driving thousands
    // of requests from 127.0.0.1 — needs to raise it without patching code.
    globalPerMin: parseInt(process.env.GLOBAL_RATE_LIMIT || '120', 10),
    authPer15Min: parseInt(process.env.AUTH_RATE_LIMIT || '20', 10),
    registrationPerHour: parseInt(process.env.REGISTRATION_RATE_LIMIT || '5', 10),
    createPerHour: parseInt(process.env.CREATE_RATE_LIMIT || '10', 10),
    walletSignPerMin: parseInt(process.env.WALLET_SIGN_RATE_LIMIT || '60', 10),
    serviceAuthPerMin: parseInt(process.env.SERVICE_AUTH_RATE_LIMIT || '60', 10),
  },
};

// ── Chain module activation ─────────────────────────────────────
//
// Blockchain is a notary, never an authority: a pure-federation PDS carries
// zero chain surface. The chain module (attestor registration, oracle
// endpoints) activates only when explicitly configured — either by
// supplying at least one chain adapter, or by opting in directly.
//
// Read once and cached; `setChainModuleEnabledForTests` lets tests flip
// the flag at runtime without re-importing this module or mutating
// `process.env` mid-suite.

let cachedChainModuleEnabled: boolean | null = null;
let chainModuleEnabledTestOverride: boolean | undefined;

export function isChainModuleEnabled(): boolean {
  if (chainModuleEnabledTestOverride !== undefined) return chainModuleEnabledTestOverride;
  if (cachedChainModuleEnabled === null) {
    cachedChainModuleEnabled =
      Boolean(process.env.CHAIN_ADAPTERS?.trim()) || process.env.GOVERNANCE_CHAIN_ENABLED === 'true';
  }
  return cachedChainModuleEnabled;
}

/** Test-only override. Pass `undefined` to restore normal env-driven behavior. */
export function setChainModuleEnabledForTests(value: boolean | undefined): void {
  chainModuleEnabledTestOverride = value;
}
