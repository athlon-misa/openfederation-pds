import express, { Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { config } from '../config.js';
import { testConnection } from '../db/client.js';
import createCommunity from '../api/net.openfederation.community.create.js';
import getRecord from '../api/com.atproto.repo.getRecord.js';
import putRecord from '../api/com.atproto.repo.putRecord.js';
import createRecord from '../api/com.atproto.repo.createRecord.js';
import deleteRecord from '../api/com.atproto.repo.deleteRecord.js';
import describeRepo from '../api/com.atproto.repo.describeRepo.js';
import listRecords from '../api/com.atproto.repo.listRecords.js';
import syncGetRepo from '../api/com.atproto.sync.getRepo.js';
import createSession from '../api/com.atproto.server.createSession.js';
import refreshSession from '../api/com.atproto.server.refreshSession.js';
import getSession from '../api/com.atproto.server.getSession.js';
import deleteSession from '../api/com.atproto.server.deleteSession.js';
import registerAccount from '../api/net.openfederation.account.register.js';
import approveAccount from '../api/net.openfederation.account.approve.js';
import rejectAccount from '../api/net.openfederation.account.reject.js';
import listPendingAccounts from '../api/net.openfederation.account.listPending.js';
import createInvite from '../api/net.openfederation.invite.create.js';
import listMyCommunities from '../api/net.openfederation.community.listMine.js';
import getCommunity from '../api/net.openfederation.community.get.js';
import listAllCommunities from '../api/net.openfederation.community.listAll.js';
import updateCommunity from '../api/net.openfederation.community.update.js';
import joinCommunity from '../api/net.openfederation.community.join.js';
import leaveCommunity from '../api/net.openfederation.community.leave.js';
import listMembers from '../api/net.openfederation.community.listMembers.js';
import listJoinRequests from '../api/net.openfederation.community.listJoinRequests.js';
import resolveJoinRequest from '../api/net.openfederation.community.resolveJoinRequest.js';
import exportCommunity from '../api/net.openfederation.community.export.js';
import suspendCommunity from '../api/net.openfederation.community.suspend.js';
import unsuspendCommunity from '../api/net.openfederation.community.unsuspend.js';
import takedownCommunity from '../api/net.openfederation.community.takedown.js';
import transferCommunity from '../api/net.openfederation.community.transfer.js';
import removeMember from '../api/net.openfederation.community.removeMember.js';
import deleteCommunity from '../api/net.openfederation.community.delete.js';
import listAccounts from '../api/net.openfederation.account.list.js';
import listInvites from '../api/net.openfederation.invite.list.js';
import listAudit from '../api/net.openfederation.audit.list.js';
import getServerConfig from '../api/net.openfederation.server.getConfig.js';
import { authMiddleware } from '../auth/middleware.js';
import { ensureBootstrapAdmin } from '../auth/bootstrap.js';

const app = express();

// CORS middleware
app.use((req, res, next) => {
  const origins = (process.env.CORS_ORIGINS || 'http://localhost:3001')
    .split(',')
    .map(o => o.trim())
    .filter(Boolean);
  const origin = req.headers.origin;
  if (origin && origins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  next();
});

// Middleware - explicit body size limit
app.use(express.json({ limit: '256kb' }));
app.use(authMiddleware);

// Request logging middleware (redact query string to prevent leaking sensitive data)
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// Rate limiters
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,  // 1 minute
  max: 120,              // 120 requests per minute
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'RateLimitExceeded', message: 'Too many requests, please try again later' },
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 minutes
  max: 20,                     // 20 login attempts per 15 min
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'RateLimitExceeded', message: 'Too many authentication attempts, please try again later' },
});

const registrationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,  // 1 hour
  max: 5,                      // 5 registrations per hour per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'RateLimitExceeded', message: 'Too many registration attempts, please try again later' },
});

const createLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,  // 1 hour
  max: 10,                     // 10 community creations per hour
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'RateLimitExceeded', message: 'Too many creation requests, please try again later' },
});

// Apply global rate limiter
app.use(globalLimiter);

// XRPC Handler type
export type XRPCHandler = (req: Request, res: Response) => Promise<void> | void;

// Static handler registry (frozen after initialization to prevent runtime modification)
const handlers: Readonly<Record<string, { handler: XRPCHandler; limiter?: ReturnType<typeof rateLimit> }>> = Object.freeze({
  // Custom OpenFederation methods
  'net.openfederation.community.create': { handler: createCommunity, limiter: createLimiter },
  'net.openfederation.account.register': { handler: registerAccount, limiter: registrationLimiter },
  'net.openfederation.account.approve': { handler: approveAccount },
  'net.openfederation.account.reject': { handler: rejectAccount },
  'net.openfederation.account.listPending': { handler: listPendingAccounts },
  'net.openfederation.invite.create': { handler: createInvite },
  'net.openfederation.account.list': { handler: listAccounts },
  'net.openfederation.invite.list': { handler: listInvites },
  'net.openfederation.audit.list': { handler: listAudit },
  'net.openfederation.server.getConfig': { handler: getServerConfig },
  'net.openfederation.community.listMine': { handler: listMyCommunities },
  'net.openfederation.community.get': { handler: getCommunity },
  'net.openfederation.community.listAll': { handler: listAllCommunities },
  'net.openfederation.community.update': { handler: updateCommunity },
  'net.openfederation.community.join': { handler: joinCommunity },
  'net.openfederation.community.leave': { handler: leaveCommunity },
  'net.openfederation.community.listMembers': { handler: listMembers },
  'net.openfederation.community.listJoinRequests': { handler: listJoinRequests },
  'net.openfederation.community.resolveJoinRequest': { handler: resolveJoinRequest },
  'net.openfederation.community.export': { handler: exportCommunity },
  'net.openfederation.community.suspend': { handler: suspendCommunity },
  'net.openfederation.community.unsuspend': { handler: unsuspendCommunity },
  'net.openfederation.community.takedown': { handler: takedownCommunity },
  'net.openfederation.community.transfer': { handler: transferCommunity },
  'net.openfederation.community.removeMember': { handler: removeMember },
  'net.openfederation.community.delete': { handler: deleteCommunity },

  // Standard ATProto endpoints
  'com.atproto.server.createSession': { handler: createSession, limiter: authLimiter },
  'com.atproto.server.refreshSession': { handler: refreshSession, limiter: authLimiter },
  'com.atproto.server.getSession': { handler: getSession },
  'com.atproto.server.deleteSession': { handler: deleteSession },
  'com.atproto.repo.getRecord': { handler: getRecord },
  'com.atproto.repo.putRecord': { handler: putRecord },
  'com.atproto.repo.createRecord': { handler: createRecord },
  'com.atproto.repo.deleteRecord': { handler: deleteRecord },
  'com.atproto.repo.describeRepo': { handler: describeRepo },
  'com.atproto.repo.listRecords': { handler: listRecords },
  'com.atproto.sync.getRepo': { handler: syncGetRepo },
});

// XRPC Router - supports both GET and POST
app.all('/xrpc/:nsid', async (req: Request, res: Response) => {
  const nsid = req.params.nsid;

  if (!nsid || typeof nsid !== 'string') {
    return res.status(400).json({
      error: 'InvalidRequest',
      message: 'nsid parameter is required'
    });
  }

  try {
    const entry = handlers[nsid];

    if (!entry) {
      return res.status(404).json({
        error: 'MethodNotFound',
        message: 'XRPC method not found'
      });
    }

    // Apply endpoint-specific rate limiter if configured
    if (entry.limiter) {
      await new Promise<void>((resolve, reject) => {
        entry.limiter!(req, res, (err: any) => {
          if (err) reject(err);
          else resolve();
        });
      });
      // If rate limiter already sent a response, don't continue
      if (res.headersSent) return;
    }

    await entry.handler(req, res);
  } catch (err) {
    if (!res.headersSent) {
      console.error(`Error handling XRPC request for ${nsid}:`, err);
      res.status(500).json({
        error: 'InternalServerError',
        message: 'An internal error occurred'
      });
    }
  }
});

// Health check endpoint
app.get('/health', async (req, res) => {
  const dbStatus = await testConnection();
  res.json({
    status: dbStatus ? 'ok' : 'degraded',
    database: dbStatus ? 'connected' : 'disconnected',
    timestamp: new Date().toISOString()
  });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    service: 'OpenFederation PDS',
    version: '1.0.0',
    description: 'Personal Data Server for OpenFederation communities',
  });
});

// Start the server
export async function startServer(): Promise<void> {
  // Security check: refuse to start with insecure JWT secret in production
  if (config.auth.jwtSecretIsInsecure) {
    if (process.env.NODE_ENV === 'production') {
      console.error('FATAL: AUTH_JWT_SECRET is not set or is insecure. Refusing to start in production.');
      console.error('Set AUTH_JWT_SECRET to a random string of at least 32 characters.');
      process.exit(1);
    } else {
      console.warn('WARNING: AUTH_JWT_SECRET is not set or is insecure. This is only acceptable for local development.');
      console.warn('Set AUTH_JWT_SECRET to a random string of at least 32 characters before deploying.');
    }
  }

  // Security check: KEY_ENCRYPTION_SECRET needed for key storage
  if (!config.keyEncryptionSecret) {
    if (process.env.NODE_ENV === 'production') {
      console.error('FATAL: KEY_ENCRYPTION_SECRET is not set. Required for encrypting keys at rest.');
      process.exit(1);
    } else {
      console.warn('WARNING: KEY_ENCRYPTION_SECRET is not set. Community creation with did:plc will fail.');
    }
  }

  // Test database connection before starting
  console.log('Testing database connection...');
  console.log(`Database config: ${config.database.user}@${config.database.host}:${config.database.port}/${config.database.database}`);

  const dbConnected = await testConnection();
  if (!dbConnected) {
    console.error('WARNING: Database connection failed!');
    console.error('The server will start but database-dependent features will not work.');
    console.error('Please configure your database connection in the .env file:');
    console.error('  DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD');
  } else {
    console.log('Database connection successful');
    await ensureBootstrapAdmin();
  }

  return new Promise((resolve) => {
    app.listen(config.port, () => {
      console.log(`Server listening on port ${config.port}`);
      if (!dbConnected) {
        console.log('WARNING: Running without database connection');
      }
      resolve();
    });
  });
}

export { app };
