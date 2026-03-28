import { config } from '../config.js';

const BRAND = 'OpenFederation';
const BASE_STYLE = `
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  color: #1a1a2e; line-height: 1.6; max-width: 600px; margin: 0 auto; padding: 2rem;
`;

function wrap(title: string, body: string): string {
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body style="${BASE_STYLE}">
  <h2 style="color: #0f3460;">${BRAND}</h2>
  <h3>${title}</h3>
  ${body}
  <hr style="border: none; border-top: 1px solid #dee2e6; margin: 2rem 0;">
  <p style="font-size: 0.85rem; color: #6c757d;">
    This email was sent by your ${BRAND} PDS at ${config.pds.hostname || 'localhost'}.
    If you did not request this, you can safely ignore it.
  </p>
</body></html>`;
}

export function passwordResetEmail(handle: string, resetUrl: string, expiresMinutes: number): string {
  return wrap('Password Reset', `
    <p>Hi <strong>${handle}</strong>,</p>
    <p>A password reset was requested for your account. Click the link below to set a new password:</p>
    <p><a href="${resetUrl}" style="display: inline-block; padding: 0.75rem 1.5rem; background: #0f3460; color: #fff; text-decoration: none; border-radius: 4px;">Reset Password</a></p>
    <p>This link expires in ${expiresMinutes} minutes.</p>
    <p>If you didn't request this, no action is needed — your password has not been changed.</p>
  `);
}

export function sessionsRevokedEmail(handle: string, count: number): string {
  return wrap('Sessions Revoked', `
    <p>Hi <strong>${handle}</strong>,</p>
    <p><strong>${count}</strong> active session${count !== 1 ? 's were' : ' was'} revoked on your account.</p>
    <p>If you did not do this, change your password immediately.</p>
  `);
}

export function passwordChangedEmail(handle: string): string {
  return wrap('Password Changed', `
    <p>Hi <strong>${handle}</strong>,</p>
    <p>Your password was successfully changed and all sessions have been invalidated.</p>
    <p>If you did not do this, contact your PDS administrator immediately.</p>
  `);
}
