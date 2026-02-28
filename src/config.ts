import dotenv from 'dotenv';

dotenv.config();

const INSECURE_JWT_DEFAULTS = ['dev-secret-change-me', 'change_me', ''];

const jwtSecret = process.env.AUTH_JWT_SECRET || '';

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

  // OAuth configuration
  oauth: {
    enabled: process.env.OAUTH_ENABLED !== 'false',
    dpopSecret: process.env.OAUTH_DPOP_SECRET || '',
    signingKey: process.env.OAUTH_SIGNING_KEY || '',  // ES256 private key as JWK JSON
    trustedClients: (process.env.OAUTH_TRUSTED_CLIENTS || '').split(',').filter(Boolean),
    redisUrl: process.env.REDIS_URL || '',
  },
};
