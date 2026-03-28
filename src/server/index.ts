import express, { Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
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
import { authMiddleware, setOAuthVerifier } from '../auth/middleware.js';
import { ensureBootstrapAdmin } from '../auth/bootstrap.js';
import { query } from '../db/client.js';
import { createOAuthProvider } from '../oauth/oauth-setup.js';
import { createOAuthRouter } from '../oauth/oauth-routes.js';
import { createExternalOAuthClient } from '../oauth/external-client.js';
import { createExternalOAuthRouter } from '../oauth/external-routes.js';
import resolveExternal from '../api/net.openfederation.account.resolveExternal.js';
import partnerRegister from '../api/net.openfederation.partner.register.js';
import createPartnerKey from '../api/net.openfederation.partner.createKey.js';
import listPartnerKeys from '../api/net.openfederation.partner.listKeys.js';
import revokePartnerKey from '../api/net.openfederation.partner.revokeKey.js';
import linkApplication from '../api/net.openfederation.community.linkApplication.js';
import unlinkApplication from '../api/net.openfederation.community.unlinkApplication.js';
import listApplications from '../api/net.openfederation.community.listApplications.js';
import verifyMembership from '../api/net.openfederation.community.verifyMembership.js';
import updateSubjectStatus from '../api/com.atproto.admin.updateSubjectStatus.js';
import getSubjectStatus from '../api/com.atproto.admin.getSubjectStatus.js';
import adminDeleteAccount from '../api/com.atproto.admin.deleteAccount.js';
import deactivateAccount from '../api/com.atproto.server.deactivateAccount.js';
import activateAccount from '../api/com.atproto.server.activateAccount.js';
import exportAccount from '../api/net.openfederation.account.export.js';
import updateRoles from '../api/net.openfederation.account.updateRoles.js';
import changePassword from '../api/net.openfederation.account.changePassword.js';
import listSessions from '../api/net.openfederation.account.listSessions.js';
import revokeSession from '../api/net.openfederation.account.revokeSession.js';
import requestPasswordReset from '../api/net.openfederation.account.requestPasswordReset.js';
import confirmPasswordReset from '../api/net.openfederation.account.confirmPasswordReset.js';
import getPublicConfig from '../api/net.openfederation.server.getPublicConfig.js';
import listPeers from '../api/net.openfederation.federation.listPeers.js';
import listPeerCommunities from '../api/net.openfederation.federation.listPeerCommunities.js';
import setExternalKey from '../api/net.openfederation.identity.setExternalKey.js';
import listExternalKeys from '../api/net.openfederation.identity.listExternalKeys.js';
import getExternalKey from '../api/net.openfederation.identity.getExternalKey.js';
import deleteExternalKey from '../api/net.openfederation.identity.deleteExternalKey.js';
import resolveByKeyHandler from '../api/net.openfederation.identity.resolveByKey.js';
import updateMemberRole from '../api/net.openfederation.community.updateMemberRole.js';
import issueAttestation from '../api/net.openfederation.community.issueAttestation.js';
import deleteAttestation from '../api/net.openfederation.community.deleteAttestation.js';
import listAttestations from '../api/net.openfederation.community.listAttestations.js';
import verifyAttestation from '../api/net.openfederation.community.verifyAttestation.js';
import updateProfile from '../api/net.openfederation.account.updateProfile.js';
import getProfileHandler from '../api/net.openfederation.account.getProfile.js';
import uploadBlob from '../api/com.atproto.repo.uploadBlob.js';
import importRepo from '../api/net.openfederation.admin.importRepo.js';
import createRole from '../api/net.openfederation.community.createRole.js';
import updateRole from '../api/net.openfederation.community.updateRole.js';
import deleteRole from '../api/net.openfederation.community.deleteRole.js';
import listRolesHandler from '../api/net.openfederation.community.listRoles.js';
import setGovernanceModel from '../api/net.openfederation.community.setGovernanceModel.js';
import createProposal from '../api/net.openfederation.community.createProposal.js';
import voteOnProposal from '../api/net.openfederation.community.voteOnProposal.js';
import listProposals from '../api/net.openfederation.community.listProposals.js';
import getProposalHandler from '../api/net.openfederation.community.getProposal.js';
import amendProposal from '../api/net.openfederation.community.amendProposal.js';
import setDelegation from '../api/net.openfederation.community.setDelegation.js';
import revokeDelegation from '../api/net.openfederation.community.revokeDelegation.js';
import getDelegationHandler from '../api/net.openfederation.community.getDelegation.js';
import createExportSchedule from '../api/net.openfederation.admin.createExportSchedule.js';
import listExportSchedules from '../api/net.openfederation.admin.listExportSchedules.js';
import deleteExportSchedule from '../api/net.openfederation.admin.deleteExportSchedule.js';
import listExportSnapshots from '../api/net.openfederation.admin.listExportSnapshots.js';
import createVerificationChallenge from '../api/net.openfederation.admin.createVerificationChallenge.js';
import verifyChallenge from '../api/net.openfederation.admin.verifyChallenge.js';
import createOracleCredential from '../api/net.openfederation.oracle.createCredential.js';
import listOracleCredentials from '../api/net.openfederation.oracle.listCredentials.js';
import revokeOracleCredential from '../api/net.openfederation.oracle.revokeCredential.js';
import { startExportScheduler } from '../scheduler/export-scheduler.js';
import { getCachedPartnerOrigins } from '../auth/partner-guard.js';
import { toMultibaseMultikeySecp256k1 } from '../identity/manager.js';
import { Secp256k1Keypair } from '@atproto/crypto';
import { decryptKeyBytes } from '../auth/encryption.js';
import { apRouter } from '../activitypub/ap-routes.js';

const app = express();

// Trust the first proxy (Railway, Render, etc.) so req.ip uses X-Forwarded-For
// and express-rate-limit identifies clients correctly.
app.set('trust proxy', config.trustProxy);

// Security headers middleware
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '0'); // Disabled per OWASP recommendation; use CSP instead
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
  }
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; script-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'"
  );
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
    const staticOrigins = (process.env.CORS_ORIGINS || 'http://localhost:3001')
      .split(',')
      .map(o => o.trim())
      .filter(Boolean);
    const origin = req.headers.origin;
    if (origin) {
      if (staticOrigins.includes(origin)) {
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
  max: parseInt(process.env.AUTH_RATE_LIMIT || '20', 10),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'RateLimitExceeded', message: 'Too many authentication attempts, please try again later' },
});

const registrationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,  // 1 hour
  max: parseInt(process.env.REGISTRATION_RATE_LIMIT || '5', 10),
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

const discoveryLimiter = rateLimit({
  windowMs: 60 * 1000,  // 1 minute
  max: 60,               // 60 discovery requests per minute per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'RateLimitExceeded', message: 'Too many discovery requests, please try again later' },
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
  'net.openfederation.invite.create': { handler: createInvite, limiter: createLimiter },
  'net.openfederation.account.list': { handler: listAccounts },
  'net.openfederation.invite.list': { handler: listInvites },
  'net.openfederation.audit.list': { handler: listAudit },
  'net.openfederation.server.getConfig': { handler: getServerConfig },
  'net.openfederation.server.getPublicConfig': { handler: getPublicConfig, limiter: discoveryLimiter },
  'net.openfederation.federation.listPeers': { handler: listPeers, limiter: discoveryLimiter },
  'net.openfederation.federation.listPeerCommunities': { handler: listPeerCommunities, limiter: discoveryLimiter },
  'net.openfederation.account.resolveExternal': { handler: resolveExternal },
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

  // ActivityPub integration endpoints
  'net.openfederation.community.linkApplication': { handler: linkApplication },
  'net.openfederation.community.unlinkApplication': { handler: unlinkApplication },
  'net.openfederation.community.listApplications': { handler: listApplications },
  'net.openfederation.community.verifyMembership': { handler: verifyMembership },

  // Partner API endpoints
  'net.openfederation.partner.register': { handler: partnerRegister, limiter: registrationLimiter },
  'net.openfederation.partner.createKey': { handler: createPartnerKey },
  'net.openfederation.partner.listKeys': { handler: listPartnerKeys },
  'net.openfederation.partner.revokeKey': { handler: revokePartnerKey },

  // External identity key endpoints
  'net.openfederation.identity.setExternalKey': { handler: setExternalKey },
  'net.openfederation.identity.listExternalKeys': { handler: listExternalKeys, limiter: discoveryLimiter },
  'net.openfederation.identity.getExternalKey': { handler: getExternalKey, limiter: discoveryLimiter },
  'net.openfederation.identity.deleteExternalKey': { handler: deleteExternalKey },
  'net.openfederation.identity.resolveByKey': { handler: resolveByKeyHandler, limiter: discoveryLimiter },

  // Community role management
  'net.openfederation.community.updateMemberRole': { handler: updateMemberRole },

  // Community role CRUD
  'net.openfederation.community.createRole': { handler: createRole },
  'net.openfederation.community.updateRole': { handler: updateRole },
  'net.openfederation.community.deleteRole': { handler: deleteRole },
  'net.openfederation.community.listRoles': { handler: listRolesHandler, limiter: discoveryLimiter },

  // Governance model and voting
  'net.openfederation.community.setGovernanceModel': { handler: setGovernanceModel },
  'net.openfederation.community.createProposal': { handler: createProposal },
  'net.openfederation.community.voteOnProposal': { handler: voteOnProposal },
  'net.openfederation.community.listProposals': { handler: listProposals, limiter: discoveryLimiter },
  'net.openfederation.community.getProposal': { handler: getProposalHandler, limiter: discoveryLimiter },
  'net.openfederation.community.amendProposal': { handler: amendProposal },

  // Delegation
  'net.openfederation.community.setDelegation': { handler: setDelegation },
  'net.openfederation.community.revokeDelegation': { handler: revokeDelegation },
  'net.openfederation.community.getDelegation': { handler: getDelegationHandler, limiter: discoveryLimiter },

  // Export scheduler admin
  'net.openfederation.admin.createExportSchedule': { handler: createExportSchedule },
  'net.openfederation.admin.listExportSchedules': { handler: listExportSchedules },
  'net.openfederation.admin.deleteExportSchedule': { handler: deleteExportSchedule },
  'net.openfederation.admin.listExportSnapshots': { handler: listExportSnapshots },

  // Community attestation endpoints
  'net.openfederation.community.issueAttestation': { handler: issueAttestation },
  'net.openfederation.community.deleteAttestation': { handler: deleteAttestation },
  'net.openfederation.community.listAttestations': { handler: listAttestations, limiter: discoveryLimiter },
  'net.openfederation.community.verifyAttestation': { handler: verifyAttestation, limiter: discoveryLimiter },

  // Profile endpoints
  'net.openfederation.account.updateProfile': { handler: updateProfile },
  'net.openfederation.account.getProfile': { handler: getProfileHandler, limiter: discoveryLimiter },

  // OpenFederation account lifecycle
  'net.openfederation.account.export': { handler: exportAccount },
  'net.openfederation.account.updateRoles': { handler: updateRoles },
  'net.openfederation.account.changePassword': { handler: changePassword, limiter: authLimiter },
  'net.openfederation.account.listSessions': { handler: listSessions },
  'net.openfederation.account.revokeSession': { handler: revokeSession },
  'net.openfederation.account.requestPasswordReset': { handler: requestPasswordReset, limiter: authLimiter },
  'net.openfederation.account.confirmPasswordReset': { handler: confirmPasswordReset, limiter: authLimiter },

  // Standard ATProto admin endpoints
  'com.atproto.admin.updateSubjectStatus': { handler: updateSubjectStatus },
  'com.atproto.admin.getSubjectStatus': { handler: getSubjectStatus },
  'com.atproto.admin.deleteAccount': { handler: adminDeleteAccount },

  // Standard ATProto endpoints
  'com.atproto.server.deactivateAccount': { handler: deactivateAccount },
  'com.atproto.server.activateAccount': { handler: activateAccount },
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
  'com.atproto.repo.uploadBlob': { handler: uploadBlob },

  // Admin repo management
  'net.openfederation.admin.importRepo': { handler: importRepo },

  // Admin identity verification challenge
  'net.openfederation.admin.createVerificationChallenge': { handler: createVerificationChallenge },
  'net.openfederation.admin.verifyChallenge': { handler: verifyChallenge },

  // Oracle credential management (admin only)
  'net.openfederation.oracle.createCredential': { handler: createOracleCredential },
  'net.openfederation.oracle.listCredentials': { handler: listOracleCredentials },
  'net.openfederation.oracle.revokeCredential': { handler: revokeOracleCredential },
});

// Blob serve route — serves binary blobs by DID + CID
app.get('/blob/:did/:cid', async (req: Request, res: Response) => {
  try {
    const did = String(req.params.did || '');
    const cid = String(req.params.cid || '');
    if (!did || !cid) {
      return res.status(400).json({ error: 'InvalidRequest', message: 'Missing did or cid' });
    }

    const { getBlobStore } = await import('../blob/blob-store.js');
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

// /.well-known/did.json — serves DID documents for did:web communities
app.get('/.well-known/did.json', discoveryLimiter, async (req: Request, res: Response) => {
  try {
    // Use configured PDS hostname to prevent HTTP host header injection.
    // The Host header can be spoofed; trust only our configuration.
    const hostname = config.pds.hostname;
    if (!hostname) {
      return res.status(500).json({ error: 'InternalServerError', message: 'PDS hostname not configured' });
    }

    // Look up did:web community by hostname
    const did = `did:web:${hostname}`;
    const result = await query<{ did: string }>(
      'SELECT did FROM communities WHERE did = $1',
      [did]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'NotFound', message: 'No did:web identity for this domain' });
    }

    // Load signing key to get public key
    const keyResult = await query<{ signing_key_bytes: Buffer }>(
      'SELECT signing_key_bytes FROM signing_keys WHERE community_did = $1',
      [did]
    );

    if (keyResult.rows.length === 0) {
      return res.status(500).json({ error: 'InternalServerError', message: 'Signing key not found' });
    }

    const decrypted = await decryptKeyBytes(keyResult.rows[0].signing_key_bytes);
    const keypair = await Secp256k1Keypair.import(decrypted, { exportable: false });
    const publicKeyMultibase = toMultibaseMultikeySecp256k1(keypair.publicKeyBytes());

    const didDocument = {
      '@context': ['https://www.w3.org/ns/did/v1'],
      id: did,
      alsoKnownAs: [`at://${hostname}`],
      verificationMethod: [
        {
          id: `${did}#atproto`,
          type: 'Multikey',
          controller: did,
          publicKeyMultibase,
        },
      ],
      service: [
        {
          id: '#atproto_pds',
          type: 'AtprotoPersonalDataServer',
          serviceEndpoint: config.pds.serviceUrl,
        },
      ],
    };

    res.setHeader('Content-Type', 'application/did+json');
    res.json(didDocument);
  } catch (err) {
    console.error('Error serving did.json:', err);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to serve DID document' });
  }
});

// /.well-known/webfinger — AT Protocol discovery for users and communities
app.get('/.well-known/webfinger', discoveryLimiter, async (req: Request, res: Response) => {
  try {
    const resource = req.query.resource as string;
    if (!resource) {
      return res.status(400).json({ error: 'BadRequest', message: 'resource query parameter required' });
    }

    let subject: string;
    let did: string | null = null;

    if (resource.startsWith('acct:')) {
      // acct:handle@domain format
      const acct = resource.substring(5); // strip "acct:"
      const atIndex = acct.indexOf('@');
      if (atIndex === -1) {
        return res.status(400).json({ error: 'BadRequest', message: 'Invalid acct URI format' });
      }
      const handle = acct.substring(0, atIndex);
      subject = resource;

      // Try users first
      const userResult = await query<{ did: string }>(
        'SELECT did FROM users WHERE handle = $1',
        [handle]
      );
      if (userResult.rows.length > 0) {
        did = userResult.rows[0].did;
      } else {
        // Try communities
        const communityResult = await query<{ did: string }>(
          'SELECT did FROM communities WHERE handle = $1',
          [handle]
        );
        if (communityResult.rows.length > 0) {
          did = communityResult.rows[0].did;
        }
      }
    } else if (resource.startsWith('at://') || resource.startsWith('did:')) {
      // Direct DID or AT URI
      const lookupDid = resource.startsWith('at://') ? resource.substring(5) : resource;
      subject = resource;

      // Try users
      const userResult = await query<{ did: string }>(
        'SELECT did FROM users WHERE did = $1',
        [lookupDid]
      );
      if (userResult.rows.length > 0) {
        did = userResult.rows[0].did;
      } else {
        // Try communities
        const communityResult = await query<{ did: string }>(
          'SELECT did FROM communities WHERE did = $1',
          [lookupDid]
        );
        if (communityResult.rows.length > 0) {
          did = communityResult.rows[0].did;
        }
      }
    } else {
      return res.status(400).json({ error: 'BadRequest', message: 'Unsupported resource URI scheme' });
    }

    if (!did) {
      return res.status(404).json({ error: 'NotFound', message: 'Resource not found' });
    }

    // Check if this DID is a community with linked AP applications
    let apActorUrl = config.pds.serviceUrl; // default: generic PDS URL
    const links: Array<{ rel: string; type: string; href: string }> = [];

    if (config.activitypub.enabled) {
      const apAppResult = await query<{ count: string }>(
        `SELECT COUNT(*) as count FROM records_index
         WHERE community_did = $1 AND collection = 'net.openfederation.community.application'`,
        [did]
      );
      if (parseInt(apAppResult.rows[0]?.count || '0', 10) > 0) {
        // Community has linked AP apps — point to the real AP actor
        apActorUrl = `${config.pds.serviceUrl}/ap/actor/${did}`;
        links.push({
          rel: 'http://webfinger.net/rel/profile-page',
          type: 'text/html',
          href: `${config.pds.serviceUrl}/communities/${did}`,
        });
      }
    }

    links.unshift(
      {
        rel: 'self',
        type: 'application/activity+json',
        href: apActorUrl,
      },
      {
        rel: 'self',
        type: 'application/json',
        href: did,
      },
    );

    const webfingerResponse = { subject, links };

    res.setHeader('Content-Type', 'application/jrd+json');
    res.json(webfingerResponse);
  } catch (err) {
    console.error('Error serving webfinger:', err);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to serve WebFinger response' });
  }
});

// SDK — serve the IIFE bundle for <script> tag usage
app.get('/sdk/v1.js', (req: Request, res: Response) => {
  // Look for the SDK bundle in several locations (dev vs production)
  const candidates = [
    join(process.cwd(), 'packages', 'openfederation-sdk', 'dist', 'index.global.js'),
    join(process.cwd(), 'dist', 'sdk', 'v1.js'),
  ];
  const sdkPath = candidates.find(p => existsSync(p));
  if (!sdkPath) {
    res.status(404).json({ error: 'NotFound', message: 'SDK bundle not found. Run: cd packages/openfederation-sdk && npm run build' });
    return;
  }
  const js = readFileSync(sdkPath, 'utf-8');
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.send(js);
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

// Auto-migrate schema if needed (for fresh Railway deploys)
async function ensureSchema(): Promise<void> {
  const result = await query(
    "SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'users')"
  );
  if (!result.rows[0].exists) {
    console.log('No schema detected, initializing database...');
    // schema.sql lives in src/db/ — try source first, then project root
    const candidates = [
      join(process.cwd(), 'src', 'db', 'schema.sql'),
      join(process.cwd(), 'schema.sql'),
    ];
    const schemaPath = candidates.find(p => existsSync(p));
    if (!schemaPath) {
      console.error('FATAL: Could not find schema.sql to initialize database');
      process.exit(1);
    }
    const schema = readFileSync(schemaPath, 'utf-8');
    await query(schema);
    console.log('Database schema initialized');
  }
}

// Periodic cleanup of expired and revoked sessions
const SESSION_CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
let sessionCleanupTimer: ReturnType<typeof setInterval> | null = null;

async function cleanupExpiredSessions(): Promise<void> {
  try {
    const result = await query(
      `DELETE FROM sessions WHERE expires_at < CURRENT_TIMESTAMP OR revoked_at IS NOT NULL`
    );
    if (result.rowCount && result.rowCount > 0) {
      console.log(`Session cleanup: removed ${result.rowCount} expired/revoked sessions`);
    }
  } catch (err) {
    console.error('Session cleanup failed:', err);
  }
}

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
    await ensureBootstrapAdmin();

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

    // Mount ActivityPub routes if enabled
    if (config.activitypub.enabled) {
      app.use(apRouter);
      console.log('ActivityPub discovery endpoints enabled');
    }

    // Schedule periodic session cleanup
    await cleanupExpiredSessions(); // run once at startup
    sessionCleanupTimer = setInterval(cleanupExpiredSessions, SESSION_CLEANUP_INTERVAL_MS);
    sessionCleanupTimer.unref(); // don't prevent process from exiting
  }

  return new Promise((resolve) => {
    app.listen(config.port, () => {
      console.log(`Server listening on port ${config.port}`);
      if (!dbConnected) {
        console.log('WARNING: Running without database connection');
      }
      // Start export scheduler after server is listening
      startExportScheduler();
      resolve();
    });
  });
}

export { app };
