import { Request, Response } from 'express';
import crypto from 'crypto';
import { query } from '../db/client.js';
import { requireAuth, requireRole } from '../auth/guards.js';
import { auditLog } from '../db/audit.js';
import { sendEmail } from '../email/email-service.js';
import type { AuthRequest } from '../auth/types.js';

export default async function createVerificationChallenge(req: Request, res: Response): Promise<void> {
  if (!requireAuth(req as AuthRequest, res)) return;
  if (!requireRole(req as AuthRequest, res, ['admin'])) return;

  const { did } = req.body || {};
  if (!did) {
    res.status(400).json({ error: 'InvalidRequest', message: 'did is required.' });
    return;
  }

  const userResult = await query<{ id: string; handle: string; email: string }>(
    'SELECT id, handle, email FROM users WHERE did = $1',
    [did]
  );
  if (userResult.rows.length === 0) {
    res.status(404).json({ error: 'NotFound', message: 'User not found.' });
    return;
  }

  const user = userResult.rows[0];
  const nonce = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

  // Store nonce (reuse password_reset_tokens table with a special prefix)
  const nonceHash = crypto.createHash('sha256').update(`verify:${nonce}`).digest('hex');
  await query(
    `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
     VALUES ($1, $2, $3)`,
    [user.id, nonceHash, expiresAt.toISOString()]
  );

  // Send nonce to user's email
  const html = `<!DOCTYPE html><html><body style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 2rem;">
    <h2>Identity Verification</h2>
    <p>Hi <strong>${user.handle}</strong>,</p>
    <p>A PDS administrator has requested identity verification for your account.</p>
    <p>Your verification code is:</p>
    <div style="background: #e9ecef; padding: 1rem; border-radius: 4px; font-family: monospace; font-size: 1.2rem; text-align: center; letter-spacing: 2px;">${nonce}</div>
    <p>This code expires in 10 minutes.</p>
    <p>Share this code with the administrator only if you initiated this request. If you did not, ignore this email.</p>
  </body></html>`;

  await sendEmail(user.email, 'Identity Verification — OpenFederation', html);

  await auditLog('admin.verification.create', (req as AuthRequest).auth!.userId, user.id, {
    targetDid: did,
  });

  res.status(200).json({
    success: true,
    message: `Verification code sent to ${user.email}. Ask the user for the code.`,
    expiresAt: expiresAt.toISOString(),
  });
}
