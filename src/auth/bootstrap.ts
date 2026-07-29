import { config } from '../config.js';
import { query } from '../db/client.js';
import { hashPassword } from './password.js';
import { createLocalDid, isStrongPassword, normalizeEmail, normalizeHandle, passwordValidationMessage } from './utils.js';
import crypto from 'crypto';

const REPOSITORY_KNOWN_BOOTSTRAP_PASSWORDS = new Set([
  'AdminPass1234',
]);

export function validateBootstrapAdminConfig(): void {
  const email = config.auth.bootstrapAdminEmail.trim();
  const handle = config.auth.bootstrapAdminHandle.trim();
  const password = config.auth.bootstrapAdminPassword;
  const configuredValues = [email, handle, password].filter(Boolean).length;

  if (configuredValues === 0) {
    return;
  }

  if (configuredValues !== 3) {
    throw new Error(
      'Bootstrap admin configuration is incomplete: set BOOTSTRAP_ADMIN_EMAIL, ' +
      'BOOTSTRAP_ADMIN_HANDLE, and BOOTSTRAP_ADMIN_PASSWORD together, or leave all three unset.',
    );
  }

  if (REPOSITORY_KNOWN_BOOTSTRAP_PASSWORDS.has(password)) {
    throw new Error('Bootstrap admin password is repository-known and must be replaced.');
  }

  if (!isStrongPassword(password)) {
    throw new Error(`Bootstrap admin password does not meet strength requirements. ${passwordValidationMessage()}`);
  }
}

export async function ensureBootstrapAdmin(runQuery: typeof query = query): Promise<void> {
  validateBootstrapAdminConfig();

  const email = config.auth.bootstrapAdminEmail.trim();
  const handle = config.auth.bootstrapAdminHandle.trim();
  const password = config.auth.bootstrapAdminPassword;

  if (!email && !handle && !password) {
    return;
  }

  const normalizedEmail = normalizeEmail(email);
  const normalizedHandle = normalizeHandle(handle);

  const existing = await runQuery<{ id: string; status: string; email: string; handle: string }>(
    'SELECT id, status, email, handle FROM users WHERE email = $1 OR handle = $2',
    [normalizedEmail, normalizedHandle]
  );

  if (existing.rows.length > 0) {
    const exactMatch = existing.rows.find(
      row => normalizeEmail(row.email) === normalizedEmail
        && normalizeHandle(row.handle) === normalizedHandle,
    );

    if (!exactMatch) {
      throw new Error(
        'Bootstrap admin identifier mismatch: an existing account matches only the configured email or handle.',
      );
    }

    const userId = exactMatch.id;
    if (exactMatch.status !== 'approved') {
      await runQuery(
        `UPDATE users
         SET status = 'approved',
             approved_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [userId]
      );
    }
    await runQuery(
      `INSERT INTO user_roles (user_id, role)
       VALUES ($1, 'admin'), ($1, 'moderator'), ($1, 'partner-manager'), ($1, 'auditor'), ($1, 'user')
       ON CONFLICT DO NOTHING`,
      [userId]
    );
    console.warn(
      'WARNING: BOOTSTRAP_ADMIN_PASSWORD is still set in your environment. ' +
      'The admin account already exists — remove this variable to reduce your attack surface.'
    );
    return;
  }

  const userId = crypto.randomUUID();
  const passwordHash = await hashPassword(password);
  const did = createLocalDid();

  await runQuery(
    `INSERT INTO users (id, handle, email, password_hash, status, did, approved_at)
     VALUES ($1, $2, $3, $4, 'approved', $5, CURRENT_TIMESTAMP)`,
    [userId, normalizedHandle, normalizedEmail, passwordHash, did]
  );

  await runQuery(
    `INSERT INTO user_roles (user_id, role)
     VALUES ($1, 'admin'), ($1, 'moderator'), ($1, 'partner-manager'), ($1, 'auditor'), ($1, 'user')`,
    [userId]
  );

  console.log('✓ Bootstrap admin user created');
}
