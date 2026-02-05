import { Request, Response } from 'express';
import { createPlcIdentity, createWebIdentity } from '../identity/manager';
import { SimpleRepoEngine } from '../repo/simple-engine';
import { query } from '../db/client';

interface CreateCommunityInput {
  handle: string;
  didMethod: 'plc' | 'web';
  domain?: string; // Required if didMethod is 'web'
  displayName?: string;
  description?: string;
}

/**
 * net.openfederation.community.create
 *
 * Creates a new community with a chosen DID method.
 * This is the entry point for community creation.
 */
export default async function createCommunity(req: Request, res: Response): Promise<void> {
  try {
    const input: CreateCommunityInput = req.body;

    // 1. Validate input
    if (!input.handle || !input.didMethod) {
      res.status(400).json({
        error: 'InvalidRequest',
        message: 'Missing required fields: handle and didMethod',
      });
      return;
    }

    // Validate handle format (alphanumeric and hyphens only)
    if (!/^[a-z0-9-]+$/.test(input.handle)) {
      res.status(400).json({
        error: 'InvalidRequest',
        message: 'Handle must contain only lowercase letters, numbers, and hyphens',
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
        message: `Handle "${input.handle}" is already taken`,
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
      // Create did:plc identity
      const result = await createPlcIdentity(input.handle);
      did = result.did;
      signingKey = result.signingKey;
      primaryRotationKey = result.primaryRotationKey;

      // TODO: Store the recovery key (encrypted!) in the database
      // For MVP, we'll skip encryption but note that it MUST be encrypted in production
    } else {
      // Create did:web identity
      const result = await createWebIdentity(input.domain!);
      did = result.did;
      signingKey = result.signingKey;
      didDocument = result.didDocument;
      instructions = result.instructions;
    }

    // 3. Store community in database
    await query(
      'INSERT INTO communities (did, handle, did_method) VALUES ($1, $2, $3)',
      [did, input.handle, input.didMethod]
    );

    // 4. Create initial records using the repository engine
    const engine = new SimpleRepoEngine(did);

    const now = new Date().toISOString();
    const displayName = input.displayName || input.handle;
    const description = input.description || '';

    const initialRecords = [
      {
        collection: 'net.openfederation.community.settings',
        rkey: 'self',
        record: {
          didMethod: input.didMethod,
          governanceModel: 'benevolent-dictator',
        },
      },
      {
        collection: 'net.openfederation.community.profile',
        rkey: 'self',
        record: {
          displayName,
          description,
          createdAt: now,
        },
      },
    ];

    await engine.createRepo(signingKey, initialRecords);

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
        'Without it, you cannot migrate your community to a different server.';
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
