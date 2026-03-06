import { Request, Response } from 'express';
import { query } from '../db/client.js';
import { requireRole } from '../auth/guards.js';
import type { AuthRequest } from '../auth/types.js';

export default async function listPartnerKeys(req: Request, res: Response): Promise<void> {
  if (!requireRole(req as AuthRequest, res, ['admin', 'partner-manager', 'auditor'])) return;

  try {
    const result = await query<{
      id: string;
      key_prefix: string;
      name: string;
      partner_name: string;
      permissions: string[];
      allowed_origins: string[] | null;
      rate_limit_per_hour: number;
      status: string;
      last_used_at: string | null;
      total_registrations: number;
      created_at: string;
      created_by: string | null;
      revoked_at: string | null;
    }>(
      `SELECT id, key_prefix, name, partner_name, permissions, allowed_origins,
              rate_limit_per_hour, status, last_used_at, total_registrations,
              created_at, created_by, revoked_at
       FROM partner_keys
       ORDER BY created_at DESC`
    );

    res.json({
      keys: result.rows.map((row) => ({
        id: row.id,
        keyPrefix: row.key_prefix,
        name: row.name,
        partnerName: row.partner_name,
        permissions: row.permissions,
        allowedOrigins: row.allowed_origins,
        rateLimitPerHour: row.rate_limit_per_hour,
        status: row.status,
        lastUsedAt: row.last_used_at,
        totalRegistrations: row.total_registrations,
        createdAt: row.created_at,
        createdBy: row.created_by,
        revokedAt: row.revoked_at,
      })),
    });
  } catch (error) {
    console.error('Error listing partner keys:', error);
    res.status(500).json({
      error: 'InternalServerError',
      message: 'Failed to list partner keys',
    });
  }
}
