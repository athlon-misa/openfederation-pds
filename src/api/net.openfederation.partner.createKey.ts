import { Request, Response } from 'express';
import { query } from '../db/client.js';
import { requireRole } from '../auth/guards.js';
import { generatePartnerKey } from '../auth/partner-keys.js';
import { hashToken } from '../auth/tokens.js';
import { auditLog } from '../db/audit.js';
import type { AuthRequest } from '../auth/types.js';
import crypto from 'crypto';

interface CreateKeyInput {
  name: string;
  partnerName: string;
  allowedOrigins: string[];
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

  if (!input.allowedOrigins || input.allowedOrigins.length === 0) {
    res.status(400).json({
      error: 'InvalidRequest',
      message: 'allowedOrigins is required. Provide at least one allowed origin URL.',
    });
    return;
  }

  // Validate each origin is a well-formed URL and uses http/https
  for (const origin of input.allowedOrigins) {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      res.status(400).json({
        error: 'InvalidRequest',
        message: `Invalid origin URL: ${origin}`,
      });
      return;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      res.status(400).json({
        error: 'InvalidRequest',
        message: `Origin must use http or https: ${origin}`,
      });
      return;
    }
  }

  const permissions = input.permissions || ['register'];
  const allowedOrigins = input.allowedOrigins;
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

    // Per-key verification token: the partner must publish this at
    // /.well-known/openfederation-partner.json on every allowed origin
    // before partner.verifyKey will mark the key active.
    const verificationToken = crypto.randomBytes(24).toString('base64url');
    const verificationTokenHash = hashToken(verificationToken);

    await query(
      `INSERT INTO partner_keys
         (id, key_hash, key_prefix, name, partner_name, created_by,
          permissions, allowed_origins, rate_limit_per_hour,
          verification_state, verification_token_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', $10)`,
      [
        id,
        keyHash,
        keyPrefix,
        input.name,
        input.partnerName,
        auth.userId,
        JSON.stringify(permissions),
        JSON.stringify(allowedOrigins),
        rateLimitPerHour,
        verificationTokenHash,
      ],
    );

    auditLog('partner.key.create', auth.userId, id, {
      name: input.name,
      partnerName: input.partnerName,
      allowedOrigins,
      verificationRequired: true,
    }).catch(() => {});

    const wellKnownPath = '/.well-known/openfederation-partner.json';
    const wellKnownBody = { token: verificationToken };

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
      verificationState: 'pending',
      verification: {
        token: verificationToken,
        wellKnownPath,
        wellKnownBody,
        instructions:
          `Publish this JSON at ${wellKnownPath} on each allowed origin, ` +
          `then call net.openfederation.partner.verifyKey with {id: "${id}"} ` +
          `to activate the key. Until verified, partner.register will reject ` +
          `this key.`,
      },
    });
  } catch (error) {
    console.error('Error creating partner key:', error);
    res.status(500).json({
      error: 'InternalServerError',
      message: 'Failed to create partner key',
    });
  }
}
