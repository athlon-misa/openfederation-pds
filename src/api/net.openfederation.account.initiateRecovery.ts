import { Request, Response } from 'express';
import crypto from 'crypto';
import { query } from '../db/client.js';
import { normalizeEmail, normalizeHandle } from '../auth/utils.js';
import { auditLog } from '../db/audit.js';
import { sendEmail } from '../email/email-service.js';
import { config } from '../config.js';

const RECOVERY_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

function recoveryEmail(handle: string, recoveryUrl: string, expiresMinutes: number): string {
  const BRAND = 'OpenFederation';
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #1a1a2e; line-height: 1.6; max-width: 600px; margin: 0 auto; padding: 2rem;">
  <h2 style="color: #0f3460;">${BRAND}</h2>
  <h3>Account Recovery</h3>
  <p>Hi <strong>${handle}</strong>,</p>
  <p>An account recovery was requested. Click the link below to recover access to your account:</p>
  <p><a href="${recoveryUrl}" style="display: inline-block; padding: 0.75rem 1.5rem; background: #0f3460; color: #fff; text-decoration: none; border-radius: 4px;">Recover Account</a></p>
  <p>This link expires in ${expiresMinutes} minutes.</p>
  <p>If you didn't request this, no action is needed. Someone may have entered your email by mistake.</p>
  <hr style="border: none; border-top: 1px solid #dee2e6; margin: 2rem 0;">
  <p style="font-size: 0.85rem; color: #6c757d;">
    This email was sent by your ${BRAND} PDS at ${config.pds.hostname || 'localhost'}.
    If you did not request this, you can safely ignore it.
  </p>
</body></html>`;
}

export default async function initiateRecovery(req: Request, res: Response): Promise<void> {
  try {
    const { handle, email } = req.body || {};
    if (!handle || !email) {
      res.status(400).json({
        error: 'InvalidRequest',
        message: 'handle and email are required.',
      });
      return;
    }

    const normalizedHandle = normalizeHandle(handle);
    const normalizedEmail = normalizeEmail(email);

    // Look up user by handle AND email (must both match)
    const userResult = await query<{
      id: string;
      did: string;
      handle: string;
      email: string;
      recovery_tier: number;
      auth_type: string;
    }>(
      `SELECT id, did, handle, email, recovery_tier,
              COALESCE(auth_type, 'local') as auth_type
       FROM users
       WHERE handle = $1 AND email = $2`,
      [normalizedHandle, normalizedEmail]
    );

    // Always return success to avoid leaking account existence
    if (userResult.rows.length === 0) {
      res.status(200).json({ success: true, message: 'If the account exists, a recovery email has been sent.' });
      return;
    }

    const user = userResult.rows[0];

    // External (OAuth) users cannot use email recovery
    if (user.auth_type === 'external') {
      res.status(200).json({ success: true, message: 'If the account exists, a recovery email has been sent.' });
      return;
    }

    // Check for active recovery attempt (prevents spam)
    const activeResult = await query<{ id: string }>(
      `SELECT id FROM recovery_attempts
       WHERE user_did = $1 AND status = 'pending' AND expires_at > NOW()
       LIMIT 1`,
      [user.did]
    );

    if (activeResult.rows.length > 0) {
      // Already has an active recovery — still return success to not leak info
      res.status(200).json({ success: true, message: 'If the account exists, a recovery email has been sent.' });
      return;
    }

    // Generate recovery token
    const token = crypto.randomBytes(48).toString('base64url');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const expiresAt = new Date(Date.now() + RECOVERY_TOKEN_TTL_MS);
    const attemptId = crypto.randomUUID();

    // Create recovery_attempts row
    await query(
      `INSERT INTO recovery_attempts (id, user_did, tier, status, token_hash, expires_at, initiated_by, ip_address)
       VALUES ($1, $2, $3, 'pending', $4, $5, $6, $7)`,
      [
        attemptId,
        user.did,
        user.recovery_tier ?? 1,
        tokenHash,
        expiresAt.toISOString(),
        normalizedEmail,
        req.ip || null,
      ]
    );

    // Build recovery URL
    const baseUrl = config.pds.serviceUrl || `http://localhost:${config.port}`;
    const recoveryUrl = `${baseUrl}/recover?token=${encodeURIComponent(token)}`;

    // Send recovery email
    await sendEmail(
      user.email,
      'Account Recovery — OpenFederation',
      recoveryEmail(user.handle, recoveryUrl, 60)
    );

    await auditLog('account.recovery.initiate', null, user.id, {
      tier: user.recovery_tier ?? 1,
      ip: req.ip,
    });

    res.status(200).json({ success: true, message: 'If the account exists, a recovery email has been sent.' });
  } catch (error) {
    console.error('Error initiating recovery:', error);
    // Return success even on error to not leak info
    res.status(200).json({ success: true, message: 'If the account exists, a recovery email has been sent.' });
  }
}
