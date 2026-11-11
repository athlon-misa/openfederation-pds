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

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatDate(date: Date): string {
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }) + ' (UTC)';
}

const BUTTON = 'display: inline-block; padding: 0.75rem 1.5rem; background: #0f3460; color: #fff; text-decoration: none; border-radius: 4px;';
const POLICY = 'https://github.com/athlon-misa/openfederation-pds/blob/main/docs/FAIR-USE.md';

export function takedownNoticeEmail(o: { kind: 'account' | 'community'; handle: string; tier: 'standard' | 'hard'; reason: string; deleteAfter: Date; exportUrl?: string }): string {
  const what = o.kind === 'account' ? 'Your account' : `The community <strong>${escapeHtml(o.handle)}</strong>, which you own,`;
  const body = o.tier === 'standard' && o.exportUrl
    ? `<p>You can download a full copy of the repository until <strong>${formatDate(o.deleteAfter)}</strong>. After that date it will be deleted from this server.</p>
    <p><a href="${o.exportUrl}" style="${BUTTON}">Download your data</a></p>
    <p>The download is a standard AT Protocol repository (CAR file). The link also lists your files (images and other uploads), each downloadable. Your DID stays yours, so you can bring this data to another server.</p>
    <p>Keep this link private: anyone who has it can download the data.</p>`
    : `<p>Because of the nature of the content, the data is not available for download. It is kept unchanged until <strong>${formatDate(o.deleteAfter)}</strong> and then deleted.</p>`;
  return wrap('Takedown notice', `
    <p>Hi <strong>${escapeHtml(o.handle)}</strong>,</p>
    <p>${what} has been taken down on this server and is no longer visible to anyone.</p>
    <p><strong>Reason:</strong> ${escapeHtml(o.reason)}</p>
    ${body}
    <p>If you believe this is a mistake, reply to the server's administrator before that date. The policy is described at <a href="${POLICY}">${POLICY}</a>.</p>`);
}

export function takedownExportedEmail(o: { kind: 'account' | 'community'; handle: string; deleteAfter: Date }): string {
  return wrap('Export complete', `
    <p>Hi <strong>${escapeHtml(o.handle)}</strong>,</p>
    <p>A copy of the ${o.kind} repository was downloaded. As stated in the takedown notice, the data will be deleted from this server on <strong>${formatDate(o.deleteAfter)}</strong>. This server is not a backup: keep your copy safe.</p>`);
}

export function takedownReminderEmail(o: { kind: 'account' | 'community'; handle: string; deleteAfter: Date; exportUrl: string }): string {
  return wrap('Your data will be deleted soon', `
    <p>Hi <strong>${escapeHtml(o.handle)}</strong>,</p>
    <p>The ${o.kind} <strong>${escapeHtml(o.handle)}</strong> was taken down and has not been downloaded yet. It will be deleted on <strong>${formatDate(o.deleteAfter)}</strong>.</p>
    <p><a href="${o.exportUrl}" style="${BUTTON}">Download your data</a></p>`);
}

export function accountDeleteCodeEmail(handle: string, code: string, expiresMinutes: number): string {
  return wrap('Confirm account deletion', `
    <p>Hi <strong>${escapeHtml(handle)}</strong>,</p>
    <p>Someone signed in to your account asked to delete it from this server. To confirm, enter this code together with your password:</p>
    <p style="font-size: 1.5rem; font-weight: bold; letter-spacing: 0.1em;">${code}</p>
    <p>The code expires in ${expiresMinutes} minutes. Deleting removes your account, repository and files from this server; your DID stays yours.</p>
    <p>If you did not ask for this, change your password: someone may have access to your account.</p>`);
}

const MODE_TEXT: Record<string, string> = {
  custodial: 'this server holds the key that controls your identity',
  assisted: 'you hold the key that controls your identity; this server keeps a backup key you can override',
  self: 'only you hold the key that controls your identity',
};

export function custodyChangedEmail(handle: string, from: string, to: string): string {
  return wrap('Account custody changed', `
    <p>Hi <strong>${escapeHtml(handle)}</strong>,</p>
    <p>Your account changed from <strong>${escapeHtml(from)}</strong> to <strong>${escapeHtml(to)}</strong>: ${MODE_TEXT[to] ?? ''}.</p>
    <p>If you did not do this, change your password and contact this server's operator straight away.</p>`);
}

export function serverSignedUpdateEmail(o: { handle: string; operationCid: string; why: string; cancelUntil: Date }): string {
  return wrap('Your identity was changed by this server', `
    <p>Hi <strong>${escapeHtml(o.handle)}</strong>,</p>
    <p>This server signed a change to your identity (${escapeHtml(o.why)}). It holds the backup key of your account.</p>
    <p><strong>If this was you, nothing to do.</strong> If it was not, you can cancel it with your 12-word phrase for 72 hours, until <strong>${o.cancelUntil.toUTCString()}</strong>: your key ranks above this server's. Then change your password.</p>
    <p style="font-size: 0.85rem; color: #6c757d;">Change: <code>${escapeHtml(o.operationCid)}</code></p>`);
}
