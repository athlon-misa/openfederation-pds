import { Response } from 'express';
import { createPlcIdentity, createWebIdentity, storeSigningKey } from '../identity/manager.js';
import { RepoEngine } from '../repo/repo-engine.js';
import { getKeypairForDid } from '../repo/keypair-utils.js';
import { query } from '../db/client.js';
import type { AuthRequest } from '../auth/types.js';
import { requireApprovedUser } from '../auth/guards.js';
import { isValidHandle } from '../auth/utils.js';
import { auditLog } from '../db/audit.js';
import { getDefaultRoleRecords, ROLE_COLLECTION } from '../auth/permissions.js';

interface CreateCommunityInput {
  handle: string;
  didMethod: 'plc' | 'web';
  domain?: string; // Required if didMethod is 'web'
  displayName?: string;
  description?: string;
  visibility?: 'public' | 'private';
  joinPolicy?: 'open' | 'approval';
}

/**
 * net.openfederation.community.create
 *
 * Creates a new community with a chosen DID method.
 */
export default async function createCommunity(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireApprovedUser(req, res)) {
      return;
    }

    const input: CreateCommunityInput = req.body;

    // 1. Validate input
    if (!input.handle || !input.didMethod) {
      res.status(400).json({
        error: 'InvalidRequest',
        message: 'Missing required fields: handle and didMethod',
      });
      return;
    }

    if (!isValidHandle(input.handle)) {
      res.status(400).json({
        error: 'InvalidRequest',
        message: 'Handle must be 3-30 characters, lowercase letters, numbers, and hyphens only. No leading/trailing hyphens or consecutive hyphens. Some names are reserved.',
      });
      return;
    }

    if (!['plc', 'web'].includes(input.didMethod)) {
      res.status(400).json({
        error: 'InvalidRequest',
        message: 'didMethod must be either "plc" or "web"',
      });
      return;
    }

    if (input.didMethod === 'web' && !input.domain) {
      res.status(400).json({
        error: 'InvalidRequest',
        message: 'domain is required when didMethod is "web"',
      });
      return;
    }

    // Check if handle already exists
    const existingCommunity = await query(
      'SELECT did FROM communities WHERE handle = $1',
      [input.handle]
    );

    if (existingCommunity.rows.length > 0) {
      res.status(409).json({
        error: 'HandleTaken',
        message: 'This handle is already taken',
      });
      return;
    }

    // 2. Create identity based on DID method
    let did: string;
    let signingKey: string;
    let primaryRotationKey: string | undefined;
    let didDocument: any | undefined;
    let instructions: string | undefined;

    let recoveryKeyBytes: Buffer | undefined;

    if (input.didMethod === 'plc') {
      const result = await createPlcIdentity(input.handle);
      did = result.did;
      signingKey = result.signingKey;
      primaryRotationKey = result.primaryRotationKey;
      recoveryKeyBytes = result.recoveryKeyBytes;
    } else {
      const result = await createWebIdentity(input.domain!);
      did = result.did;
      signingKey = result.signingKey;
      didDocument = result.didDocument;
      instructions = result.instructions;
    }

    // 3. Store community in database (must come before plc_keys/signing_keys due to foreign keys)
    await query(
      'INSERT INTO communities (did, handle, did_method, created_by) VALUES ($1, $2, $3, $4)',
      [did, input.handle, input.didMethod, req.auth!.userId]
    );

    // Store recovery key for did:plc (encrypted at rest)
    if (recoveryKeyBytes) {
      await query(
        'INSERT INTO plc_keys (community_did, recovery_key_bytes) VALUES ($1, $2)',
        [did, recoveryKeyBytes]
      );
    }

    // Store signing key (encrypted at rest)
    await storeSigningKey(did, signingKey);

    // 4. Create initial records using the repository engine with real MST
    const engine = new RepoEngine(did);
    const keypair = await getKeypairForDid(did);

    const now = new Date().toISOString();
    const displayName = input.displayName || input.handle;
    const description = input.description || '';
    const visibility = input.visibility || 'public';
    const joinPolicy = input.joinPolicy || 'open';

    const memberRkey = RepoEngine.generateTid();
    const defaultRoles = getDefaultRoleRecords();
    const ownerRoleRkey = RepoEngine.generateTid();
    const modRoleRkey = RepoEngine.generateTid();
    const memberRoleRkey = RepoEngine.generateTid();

    const initialRecords = [
      // Role records
      { collection: ROLE_COLLECTION, rkey: ownerRoleRkey, record: { ...defaultRoles[0].record } },
      { collection: ROLE_COLLECTION, rkey: modRoleRkey, record: { ...defaultRoles[1].record } },
      { collection: ROLE_COLLECTION, rkey: memberRoleRkey, record: { ...defaultRoles[2].record } },
      // Settings
      {
        collection: 'net.openfederation.community.settings',
        rkey: 'self',
        record: { didMethod: input.didMethod, governanceModel: 'benevolent-dictator', visibility, joinPolicy },
      },
      // Profile
      {
        collection: 'net.openfederation.community.profile',
        rkey: 'self',
        record: { displayName, description, createdAt: now },
      },
      // Owner member record with roleRkey
      {
        collection: 'net.openfederation.community.member',
        rkey: memberRkey,
        record: { did: req.auth!.did, handle: req.auth!.handle, roleRkey: ownerRoleRkey, joinedAt: now },
      },
    ];

    await engine.createRepo(keypair, initialRecords);

    await auditLog('community.create', req.auth!.userId, did, {
      handle: input.handle,
      didMethod: input.didMethod,
    });

    // 5. Return the result
    const response: any = {
      did,
      handle: input.handle,
      didMethod: input.didMethod,
    };

    if (input.didMethod === 'plc') {
      response.primaryRotationKey = primaryRotationKey;
      response.message =
        'IMPORTANT: Please back up your primaryRotationKey immediately. ' +
        'This is the only time you will see it. It grants full control over your identity. ' +
        'Without it, you cannot migrate your community to a different server. ' +
        'OpenFederation and PDS operators will NEVER ask you for this key. ' +
        'Any request for it is a phishing attempt.';
    } else {
      response.didDocument = didDocument;
      response.instructions = instructions;
    }

    res.status(201).json(response);
  } catch (error) {
    console.error('Error creating community:', error);
    res.status(500).json({
      error: 'InternalServerError',
      message: 'Failed to create community',
    });
  }
}
