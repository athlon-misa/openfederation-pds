import express, { Request, Response } from 'express';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { config } from '../config.js';
import { testConnection, closePool } from '../db/client.js';
import { authMiddleware, setOAuthVerifier } from '../auth/middleware.js';
import { ensureBootstrapAdmin, validateBootstrapAdminConfig } from '../auth/bootstrap.js';
import { completePendingSetupAdmin } from '../auth/setup-admin.js';
import { createSetupDoneRouter } from '../setup/setup-app.js';
import { query } from '../db/client.js';
import { createOAuthProvider } from '../oauth/oauth-setup.js';
import { createOAuthRouter } from '../oauth/oauth-routes.js';
import { createExternalOAuthClient } from '../oauth/external-client.js';
import { createExternalOAuthRouter } from '../oauth/external-routes.js';
import { registerAttestor } from '../governance/attestor.js';
import { createEvmAdapter, installChainModule } from '../modules/chain/index.js';
import { startExportScheduler, stopExportScheduler } from '../scheduler/export-scheduler.js';
import { startMigrationCleanup, stopMigrationCleanup } from '../scheduler/migration-cleanup.js';
import { startTakedownSweep, stopTakedownSweep } from '../moderation/takedown.js';
import { takedownExportRouter } from '../moderation/takedown-export-routes.js';
import { getCachedPartnerOrigins } from '../auth/partner-guard.js';
import { setSecurityHeaders } from './security-headers.js';
import { isAllowedStaticOrigin } from './cors-config.js';
import { getBlobStore } from '../blob/blob-store.js';
import { CID } from 'multiformats/cid';
import { apRouter } from '../activitypub/ap-routes.js';
import { globalLimiter } from './rate-limits.js';
import { verifyEmailTransport } from '../email/email-service.js';
import { createEmailWebhookRouter } from '../email/bounce-webhooks.js';
import { confirmEmailToken } from '../email/verification.js';
import { createXrpcRouter } from './xrpc-router.js';
import { createWellKnownRouter } from './well-known-routes.js';
import { createTlsCheckRouter } from './tls-check.js';
import { SERVER_VERSION } from './server-version.js';
import { applyMigrations } from '../db/migrate.js';
import { startRuntimeSettings, stopRuntimeSettings } from '../settings/runtime-settings.js';
import type { Server } from 'http';
import { createAccountPagesRouter } from './account-pages.js';
import { createWalletConsentRouter } from './wallet-consent-page.js';
import { productionConfigProblems } from './production-checks.js';
import { requireRepoReadable } from '../auth/guards.js';
import type { AuthRequest } from '../auth/types.js';

export type { XRPCHandler } from './handler-registry.js';

const app = express();
// Do not advertise the framework (X-Powered-By: Express).
app.disable('x-powered-by');

// Trust the first proxy (Railway, Render, etc.) so req.ip uses X-Forwarded-For
// and express-rate-limit identifies clients correctly.
app.set('trust proxy', config.trustProxy);

// Health check — exempt from rate limiting/auth/body parsing. Hot path
// for Railway/uptime checks, so security headers are applied inline.
/**
 * Boot-time email transport state, surfaced in /health. `null` means healthy
 * or deliberately unconfigured; a string is the verify() failure an operator
 * needs to see. Set during main(); requests before that report "unknown".
 */
let emailTransportError: string | null | undefined;

/**
 * /health is unauthenticated and sits ahead of the rate limiter (platform
 * health checks must never be throttled), so it must not run a query per
 * request. The database check is shared for a few seconds.
 */
const DB_STATUS_TTL_MS = 5_000;
let dbStatusCache: { at: number; value: Promise<Awaited<ReturnType<typeof testConnection>>> } | null = null;
function cachedDbStatus(): Promise<Awaited<ReturnType<typeof testConnection>>> {
  if (!dbStatusCache || Date.now() - dbStatusCache.at > DB_STATUS_TTL_MS) {
    dbStatusCache = { at: Date.now(), value: testConnection() };
  }
  return dbStatusCache.value;
}

app.get('/health', async (_req, res) => {
  setSecurityHeaders(res);
  const dbStatus = await cachedDbStatus();
  const email = !config.email.enabled
    ? 'not-configured'
    : emailTransportError === undefined ? 'unknown'
    : emailTransportError === null ? 'ok'
    : 'unreachable';
  res.json({
    status: dbStatus && email !== 'unreachable' ? 'ok' : 'degraded',
    database: dbStatus ? 'connected' : 'disconnected',
    email,
    timestamp: new Date().toISOString()
  });
});

// Security headers middleware (pre-computed at startup)
app.use((_req, res, next) => {
  setSecurityHeaders(res);
  next();
});

// CORS middleware
// XRPC endpoints use Access-Control-Allow-Origin: * (ATProto standard — auth
// is via bearer tokens, not cookies, so wildcard is safe). Non-XRPC paths
// (web UI, OAuth) use origin-specific CORS from CORS_ORIGINS + partner origins.
app.use(async (req, res, next) => {
  const isXrpc = req.path.startsWith('/xrpc/');
  if (isXrpc) {
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else {
    const origin = req.headers.origin;
    if (origin) {
      if (isAllowedStaticOrigin(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
      } else if (req.headers['x-partner-key'] || req.path === '/oauth/external/complete') {
        // Allow partner origins for X-Partner-Key requests and for
        // /oauth/external/complete (SDK apps exchanging temp codes for tokens)
        const partnerOrigins = await getCachedPartnerOrigins();
        if (partnerOrigins.includes(origin)) {
          res.setHeader('Access-Control-Allow-Origin', origin);
        }
      }
    }
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, DPoP, X-Partner-Key');
  res.setHeader('Access-Control-Expose-Headers', 'DPoP-Nonce, WWW-Authenticate');
  // Cache the CORS preflight for 24h so cross-origin POSTs from the SDK
  // and Web UI don't pay an OPTIONS round-trip on every call. Vary by
  // origin so browsers don't cross-pollinate per-origin responses.
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Vary', 'Origin');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  next();
});

// The global rate limiter runs before anything that costs something per
// request. Authentication can mean a database read, a partner-key lookup or a
// DID resolution against the PLC directory for an issuer the caller chose;
// done ahead of the limiter, a client already over its limit still got all of
// that work out of the server on every request.
app.use(globalLimiter);

// Body parsing — only needed for methods with request bodies
app.use((req, res, next) => {
  if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
    express.json({ limit: '256kb' })(req, res, next);
  } else {
    next();
  }
});
// Request logging middleware (redact query string to prevent leaking sensitive data)
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

app.use(authMiddleware);

// Root endpoint — service discovery. Receives full middleware chain
// (security headers, CORS, rate limiting) like any other request.
app.get('/', (_req, res) => {
  res.json({
    service: 'OpenFederation PDS',
    version: SERVER_VERSION,
    description: 'Personal Data Server for OpenFederation communities',
  });
});

// Private export links for the owner of a taken-down repository (docs/FAIR-USE.md)
app.use('/takedown-export', takedownExportRouter);

// Blob serve route — serves binary blobs by DID + CID
app.get('/blob/:did/:cid', async (req: Request, res: Response) => {
  try {
    const did = String(req.params.did || '');
    const cid = String(req.params.cid || '');
    if (!did || !cid) {
      return res.status(400).json({ error: 'InvalidRequest', message: 'Missing did or cid' });
    }
    // Same rule as com.atproto.sync.getBlob: nothing from a taken-down
    // account, nor from a private community to outsiders.
    if (!(await requireRepoReadable(req as AuthRequest, res, did,
      () => res.status(404).json({ error: 'BlobNotFound', message: 'Blob not found' })))) return;

    // Public blob URLs are CID-addressed and bound to the owning DID. Never
    // pass arbitrary storage keys (for example scheduled export paths) to the
    // shared blob store.
    try {
      if (CID.parse(cid).toString() !== cid) throw new Error('non-canonical CID');
    } catch {
      return res.status(404).json({ error: 'BlobNotFound', message: 'Blob not found' });
    }

    const metadata = await query<{ cid: string }>(
      'SELECT cid FROM blob_owners WHERE cid = $1 AND did = $2',
      [cid, did],
    );
    if (metadata.rows.length === 0) {
      return res.status(404).json({ error: 'BlobNotFound', message: 'Blob not found' });
    }

    const store = await getBlobStore();
    const blob = await store.get(cid);

    if (!blob) {
      return res.status(404).json({ error: 'BlobNotFound', message: 'Blob not found' });
    }

    res.setHeader('Content-Type', blob.mimeType);
    res.setHeader('Content-Length', blob.data.length.toString());
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.send(blob.data);
  } catch (error) {
    console.error('Error serving blob:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'InternalServerError', message: 'Failed to serve blob' });
    }
  }
});

// Chain module: mounts X-Oracle-Key authentication on the handful of routes
// that accept it, and registers the module's governance request authority
// with core. Every entry point re-checks isChainModuleEnabled() per request,
// so a PDS without the chain module authenticates no Oracle anywhere.
installChainModule(app);

// XRPC Router - supports both GET and POST
// Bounce/complaint webhooks — routes exist only when EMAIL_WEBHOOK_TOKEN is set.
app.use(createEmailWebhookRouter());

// ActivityPub discovery. Mounted unconditionally — the router gates itself on
// config.activitypub.enabled per request, so tests exercise the same code
// production runs (#85: mount-time gating inside main() left these routes
// untestable, which is how the private-community leak went unnoticed).
app.use(apRouter);

// The landing page for emailed verification links (#83). A browser GET, not
// XRPC: the person clicking has an email client and possibly no session — so
// this must work logged-out, and must render something a human can read.
// Token semantics are identical to com.atproto.server.confirmEmail; both
// call the same redeem function.
app.get('/verify-email', async (req: Request, res: Response) => {
  const page = (title: string, body: string, ok: boolean) =>
    `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title></head>
     <body style="font-family: sans-serif; max-width: 480px; margin: 4rem auto; padding: 0 1rem; text-align: center;">
     <h2 style="color: ${ok ? '#188038' : '#c5221f'};">${title}</h2><p>${body}</p></body></html>`;
  try {
    const token = typeof req.query.token === 'string' ? req.query.token : '';
    const email = typeof req.query.email === 'string' ? req.query.email : '';
    if (!token || !email) {
      res.status(400).send(page('Invalid link', 'This verification link is incomplete. Copy the full URL from the email.', false));
      return;
    }
    const result = await confirmEmailToken(email, token);
    if (!result.ok) {
      const why = result.error === 'ExpiredToken'
        ? 'This link has expired. Sign in and request a new one.'
        : 'This link is invalid or was already used.';
      res.status(400).send(page('Verification failed', why, false));
      return;
    }
    res.status(200).send(page('Email verified', 'Your email address is confirmed. You can close this page.', true));
  } catch (error) {
    console.error('Error in /verify-email:', error);
    res.status(500).send(page('Something went wrong', 'Verification could not be completed. Try the link again shortly.', false));
  }
});

// The pages the password-reset and recovery emails link to.
app.use(createAccountPagesRouter());
// The page where a user approves a dApp's request to sign with their wallet.
app.use(createWalletConsentRouter());
// The first-run setup wizard runs only before the server is configured
// (src/setup/launcher.ts); here /setup just says it is done (#405).
app.use(createSetupDoneRouter());

app.use('/xrpc', createXrpcRouter());

// /.well-known/did.json and /.well-known/webfinger — DID documents + AT
// Protocol discovery. Mounted here; src/oauth/oauth-routes.ts separately
// mounts /.well-known/oauth-* paths — no collision.
app.use('/.well-known', createWellKnownRouter());

// On-demand TLS for handle names: the appliance's Caddy asks here before it
// requests a certificate for <handle>.<handle domain> (#405).
app.use(createTlsCheckRouter());

// SDK — serve the IIFE bundle (cached in memory after first read)
let cachedSdkBundle: string | null = null;
app.get('/sdk/v1.js', (_req: Request, res: Response) => {
  if (!cachedSdkBundle) {
    const candidates = [
      join(process.cwd(), 'packages', 'openfederation-sdk', 'dist', 'index.global.js'),
      join(process.cwd(), 'dist', 'sdk', 'v1.js'),
    ];
    const sdkPath = candidates.find(p => existsSync(p));
    if (!sdkPath) {
      res.status(404).json({ error: 'NotFound', message: 'SDK bundle not found. Run: cd packages/openfederation-sdk && npm run build' });
      return;
    }
    cachedSdkBundle = readFileSync(sdkPath, 'utf-8');
  }
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.send(cachedSdkBundle);
});


// Auto-migrate schema and apply incremental migrations on every startup.
//
// On a brand-new database this runs schema.sql (the full baseline) and then
// all scripts/migrate-*.sql in filename order. On an existing database only
// the migrations run — schema.sql is skipped. Every migration is written
// with IF NOT EXISTS on CREATE TABLE / CREATE INDEX / ADD COLUMN, making
// repeated applies safe.
//
// This is the root fix for long-running deploys drifting behind the repo's
// migration set: if someone pushes migrate-026 tomorrow, the next Railway
// deploy applies it before handlers accept traffic. Nothing to remember,
// nothing to run by hand.
async function ensureSchema(): Promise<void> {
  const tableCheck = await query<{ exists: boolean }>(
    "SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'users') AS exists",
  );

  if (!tableCheck.rows[0].exists) {
    console.log('No schema detected, initializing database from schema.sql...');
    const schemaCandidates = [
      join(process.cwd(), 'src', 'db', 'schema.sql'),
      join(process.cwd(), 'schema.sql'),
    ];
    const schemaPath = schemaCandidates.find((p) => existsSync(p));
    if (!schemaPath) {
      console.error('FATAL: Could not find schema.sql to initialize database');
      process.exit(1);
    }
    await query(readFileSync(schemaPath, 'utf-8'));
    console.log('Database schema initialized');
  }

  // Apply the incremental migrations this database has not had yet.
  const migrationCandidates = [
    join(process.cwd(), 'scripts'),
    join(process.cwd(), 'dist', 'scripts'),
  ];
  const migrationsDir = migrationCandidates.find((p) => existsSync(p));
  if (!migrationsDir) {
    console.warn('No scripts/ directory found — skipping incremental migrations.');
    return;
  }
  const { applied, skipped } = await applyMigrations(migrationsDir);
  console.log(applied.length > 0
    ? `Applied ${applied.length} migration(s): ${applied[0]}..${applied[applied.length - 1]} (${skipped} already applied).`
    : `Database schema is up to date (${skipped} migrations already applied).`);
}

// Periodic cleanup of expired and revoked sessions
const SESSION_CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
let sessionCleanupTimer: ReturnType<typeof setInterval> | null = null;

export async function cleanupExpiredSessions(): Promise<void> {
  try {
    const result = await query(
      `DELETE FROM sessions WHERE expires_at < CURRENT_TIMESTAMP OR revoked_at IS NOT NULL`
    );
    if (result.rowCount && result.rowCount > 0) {
      console.log(`Session cleanup: removed ${result.rowCount} expired/revoked sessions`);
    }
    // Also clean up expired wallet link challenges
    const challengeResult = await query(
      `DELETE FROM wallet_link_challenges WHERE expires_at < CURRENT_TIMESTAMP`
    );
    if (challengeResult.rowCount && challengeResult.rowCount > 0) {
      console.log(`Challenge cleanup: removed ${challengeResult.rowCount} expired wallet link challenges`);
    }
    // Unused pseudonym login challenges pair an owner key with an expiry, so
    // do not let them linger on an idle server. No count is logged.
    await query(`DELETE FROM pseudonym_login_challenges WHERE expires_at < CURRENT_TIMESTAMP`);
  } catch (err) {
    console.error('Session cleanup failed:', err);
  }
}

// Start the server
export async function startServer(): Promise<Server> {
  // Bootstrap credentials are startup security configuration, so reject an
  // invalid or partial set even when the database is currently unavailable.
  validateBootstrapAdminConfig();

  // Security check: refuse to start with insecure JWT secret in production
  if (config.auth.jwtSecretIsInsecure) {
    if (config.env.isProduction) {
      console.error('FATAL: AUTH_JWT_SECRET is not set or is insecure. Refusing to start in production.');
      console.error('Set AUTH_JWT_SECRET to a random string of at least 32 characters.');
      process.exit(1);
    } else {
      console.warn('WARNING: AUTH_JWT_SECRET is not set or is insecure. This is only acceptable for local development.');
      console.warn('Set AUTH_JWT_SECRET to a random string of at least 32 characters before deploying.');
    }
  }

  // Email is load-bearing in production: password reset, account recovery and
  // session-revocation notices all depend on it, and until #83 a missing or
  // broken SMTP configuration was silent — reset reported success while
  // delivering nothing. So production without SMTP refuses to start, exactly
  // as it does for AUTH_JWT_SECRET, unless the operator states the choice
  // explicitly with ALLOW_NO_EMAIL=true (a closed instance genuinely may not
  // want mail; that is a decision, not an accident).
  //
  // A *configured but unreachable* transport is different: killing the server
  // over what may be a transient SMTP blip at boot would make the mail host a
  // hard dependency of everything else. It is verified, shouted about, and
  // surfaced in /health instead.
  if (!config.email.enabled) {
    if (config.env.isProduction && process.env.ALLOW_NO_EMAIL !== 'true') {
      console.error('FATAL: No SMTP configuration (SMTP_HOST) in production. Password reset and');
      console.error('account recovery would silently deliver nothing. Configure SMTP_HOST etc.,');
      console.error('or set ALLOW_NO_EMAIL=true to state explicitly that this instance sends no mail.');
      process.exit(1);
    } else if (!config.env.isProduction) {
      console.warn('WARNING: No SMTP configured — emails will be logged to the console.');
    }
  } else {
    const transport = await verifyEmailTransport();
    if (transport.state === 'unreachable') {
      console.error(`ERROR: SMTP is configured but unreachable: ${transport.error}`);
      console.error('Password reset and recovery emails will fail until this is fixed. See /health.');
      emailTransportError = transport.error;
    } else {
      console.log(`Email transport verified: ${config.email.host}:${config.email.port}`);
      emailTransportError = null;
    }
  }

  // Security check: KEY_ENCRYPTION_SECRET needed for key storage
  if (!config.keyEncryptionSecret) {
    if (config.env.isProduction) {
      console.error('FATAL: KEY_ENCRYPTION_SECRET is not set. Required for encrypting keys at rest.');
      process.exit(1);
    } else {
      console.warn('WARNING: KEY_ENCRYPTION_SECRET is not set. Community creation with did:plc will fail.');
    }
  }

  // Production rules that otherwise fail silently: a per-restart OAuth key,
  // per-instance OAuth replay protection, a clear-text database connection.
  const productionProblems = productionConfigProblems({
    isProduction: config.env.isProduction,
    oauth: { enabled: config.oauth.enabled, signingKey: config.oauth.signingKey, redisUrl: config.oauth.redisUrl },
    database: { ssl: config.database.ssl, host: config.database.host },
  });
  for (const warning of productionProblems.warnings) console.warn(`WARNING: ${warning}`);
  if (productionProblems.fatal.length > 0) {
    for (const problem of productionProblems.fatal) console.error(`FATAL: ${problem}`);
    process.exit(1);
  }

  // Test database connection before starting
  console.log('Testing database connection...');
  console.log(`Database config: ${config.database.host}:${config.database.port}/${config.database.database}`);

  const dbConnected = await testConnection();
  if (!dbConnected) {
    console.error('WARNING: Database connection failed!');
    console.error('The server will start but database-dependent features will not work.');
    console.error('Please configure your database connection in the .env file:');
    console.error('  DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD');
  } else {
    console.log('Database connection successful');
    await ensureSchema();
    // The settings an admin changed on the dashboard (#410), then re-read
    // periodically so a change made on another instance reaches this one.
    await startRuntimeSettings();
    await ensureBootstrapAdmin();
    // The first admin chosen in the setup wizard, created on the first start after it.
    const setupAdmin = await completePendingSetupAdmin();
    if (setupAdmin !== 'none') console.log('✓ Admin account from the setup wizard created');

    // Initialize OAuth provider if enabled
    if (config.oauth.enabled) {
      try {
        // Phase 2 routes first: external login routes must be mounted before
        // the OAuth provider middleware (which catches all /oauth/* paths)
        createExternalOAuthClient();
        app.use(createExternalOAuthRouter());
        console.log('OAuth external login initialized');

        // Phase 1: Authorization Server — third-party apps can authenticate local users
        const oauthProvider = await createOAuthProvider();
        app.use(createOAuthRouter(oauthProvider));
        setOAuthVerifier(oauthProvider);
        console.log('OAuth authorization server initialized');
      } catch (err) {
        console.error('Failed to initialize OAuth:', err);
        console.warn('OAuth disabled due to initialization error — server continues without OAuth');
      }
    }

    if (config.activitypub.enabled) {
      console.log('ActivityPub discovery endpoints enabled');
    }

    // Register chain adapters from config
    if (config.chains.adapters.length > 0) {
      for (const { chainId, rpcUrl } of config.chains.adapters) {
        // Derive a human-readable name from the CAIP-2 chain ID
        const name = `EVM ${chainId}`;
        registerAttestor(createEvmAdapter(chainId, name, rpcUrl));
        // Mask RPC URL to avoid leaking API keys in logs
        const maskedUrl = new URL(rpcUrl).hostname;
        console.log(`Registered chain adapter: ${name} (${maskedUrl})`);
      }
    }

    // Schedule periodic session cleanup
    await cleanupExpiredSessions(); // run once at startup
    sessionCleanupTimer = setInterval(cleanupExpiredSessions, SESSION_CLEANUP_INTERVAL_MS);
    sessionCleanupTimer.unref(); // don't prevent process from exiting
  }

  return new Promise((resolve) => {
    const server = app.listen(config.port, () => {
      console.log(`Server listening on port ${config.port}`);
      if (!dbConnected) {
        console.log('WARNING: Running without database connection');
      }
      // Start export scheduler after server is listening
      startExportScheduler();
      startMigrationCleanup();
      startTakedownSweep();
      resolve(server);
    });
  });
}

/** Stop the background work and release the database: the cleanup half of a shutdown. */
export async function releaseServerResources(): Promise<void> {
  stopExportScheduler();
  stopMigrationCleanup();
  stopTakedownSweep();
  stopRuntimeSettings();
  if (sessionCleanupTimer) {
    clearInterval(sessionCleanupTimer);
    sessionCleanupTimer = null;
  }
  await closePool();
}

export { app };
