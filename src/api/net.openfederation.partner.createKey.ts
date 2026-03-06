import { Request, Response } from 'express';
import { query } from '../db/client.js';
import { requireRole } from '../auth/guards.js';
import { generatePartnerKey } from '../auth/partner-keys.js';
import { auditLog } from '../db/audit.js';
import type { AuthRequest } from '../auth/types.js';
import crypto from 'crypto';

interface CreateKeyInput {
  name: string;
  partnerName: string;
  allowedOrigins?: string[];
  rateLimitPerHour?: number;
  permissions?: string[];
}

export default async function createPartnerKey(req: Request, res: Response): Promise<void> {
  if (!requireRole(req as AuthRequest, res, ['admin', 'partner-manager'])) return;
  const auth = (req as AuthRequest).auth!;

  const input: CreateKeyInput = req.body;

  if (!input?.name || !input?.partnerName) {
    res.status(400).json({
      error: 'InvalidRequest',
      message: 'name and partnerName are required',
    });
    return;
  }

  if (input.name.length > 255 || input.partnerName.length > 255) {
    res.status(400).json({
      error: 'InvalidRequest',
      message: 'name and partnerName must be 255 characters or fewer',
    });
    return;
  }

  const permissions = input.permissions || ['register'];
  const allowedOrigins = input.allowedOrigins || null;
  const rateLimitPerHour = input.rateLimitPerHour || 100;

  if (rateLimitPerHour < 1 || rateLimitPerHour > 10000) {
    res.status(400).json({
      error: 'InvalidRequest',
      message: 'rateLimitPerHour must be between 1 and 10000',
    });
    return;
  }

  try {
    const id = crypto.randomUUID();
    const { rawKey, keyHash, keyPrefix } = generatePartnerKey();

    await query(
      `INSERT INTO partner_keys (id, key_hash, key_prefix, name, partner_name, created_by, permissions, allowed_origins, rate_limit_per_hour)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        id,
        keyHash,
        keyPrefix,
        input.name,
        input.partnerName,
        auth.userId,
        JSON.stringify(permissions),
        allowedOrigins ? JSON.stringify(allowedOrigins) : null,
        rateLimitPerHour,
      ]
    );

    auditLog('partner.key.create', auth.userId, id, {
      name: input.name,
      partnerName: input.partnerName,
    }).catch(() => {});

    // Return raw key ONCE — never stored, never retrievable
    res.status(201).json({
      id,
      key: rawKey,
      keyPrefix,
      name: input.name,
      partnerName: input.partnerName,
      permissions,
      allowedOrigins,
      rateLimitPerHour,
      status: 'active',
    });
  } catch (error) {
    console.error('Error creating partner key:', error);
    res.status(500).json({
      error: 'InternalServerError',
      message: 'Failed to create partner key',
    });
  }
}
