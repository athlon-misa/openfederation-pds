import { Response } from 'express';
import crypto from 'crypto';
import type { AuthRequest } from '../auth/types.js';
import { requireAuth, requireRole } from '../auth/guards.js';
import { generateOracleKey } from '../auth/oracle-keys.js';
import { auditLog } from '../db/audit.js';
import { query } from '../db/client.js';

export default async function createOracleCredential(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireAuth(req, res)) return;
    if (!requireRole(req, res, ['admin'])) return;

    const { communityDid, name, allowedOrigins } = req.body || {};

    if (!communityDid || !name) {
      res.status(400).json({ error: 'InvalidRequest', message: 'communityDid and name are required.' });
      return;
    }

    // Verify community exists
    const communityResult = await query('SELECT 1 FROM communities WHERE did = $1', [communityDid]);
    if (communityResult.rows.length === 0) {
      res.status(404).json({ error: 'InvalidRequest', message: 'Community not found.' });
      return;
    }

    // Check for existing active credential
    const existingResult = await query(
      `SELECT 1 FROM oracle_credentials WHERE community_did = $1 AND status = 'active'`,
      [communityDid]
    );
    if (existingResult.rows.length > 0) {
      res.status(409).json({
        error: 'CredentialExists',
        message: 'An active Oracle credential already exists for this community. Revoke it first.',
      });
      return;
    }

    const { rawKey, keyHash, keyPrefix } = generateOracleKey();
    const id = crypto.randomUUID();

    await query(
      `INSERT INTO oracle_credentials (id, community_did, key_prefix, key_hash, name, created_by, allowed_origins)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, communityDid, keyPrefix, keyHash, name, req.auth!.userId, allowedOrigins ? JSON.stringify(allowedOrigins) : null]
    );

    await auditLog('oracle.credential.create', req.auth!.userId, communityDid, {
      credentialId: id, name, keyPrefix,
    });

    res.status(201).json({ id, key: rawKey, keyPrefix, communityDid, name });
  } catch (error) {
    console.error('Error creating Oracle credential:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to create credential.' });
  }
}
