import dotenv from 'dotenv';

dotenv.config();

const INSECURE_JWT_DEFAULTS = ['dev-secret-change-me', 'change_me', ''];

const jwtSecret = process.env.AUTH_JWT_SECRET || '';

function parseTrustProxy(val: string | undefined): string | number | boolean {
  if (!val) return 1;
  if (val === 'true') return true;
  if (val === 'false') return false;
  const num = parseInt(val, 10);
  if (!isNaN(num)) return num;
  return val;
}

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
  },

  // PDS configuration
  pds: {
    hostname: process.env.PDS_HOSTNAME || 'pds.openfederation.net',
    serviceUrl: process.env.PDS_SERVICE_URL || 'https://pds.openfederation.net',
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

  // Express trust proxy configuration (for rate limiting and req.ip with proxies)
  trustProxy: parseTrustProxy(process.env.EXPRESS_TRUST_PROXY),
};
