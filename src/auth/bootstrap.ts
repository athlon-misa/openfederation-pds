import { config } from '../config.js';
import { query } from '../db/client.js';
import { hashPassword } from './password.js';
import { createLocalDid, isStrongPassword, normalizeEmail, normalizeHandle, passwordValidationMessage } from './utils.js';
import crypto from 'crypto';

export async function ensureBootstrapAdmin(): Promise<void> {
  const email = config.auth.bootstrapAdminEmail.trim();
  const handle = config.auth.bootstrapAdminHandle.trim();
  const password = config.auth.bootstrapAdminPassword;

  if (!email || !handle || !password) {
    return;
  }

  if (!isStrongPassword(password)) {
    console.error(`WARNING: Bootstrap admin password does not meet strength requirements. ${passwordValidationMessage()}`);
    if (process.env.NODE_ENV === 'production') {
      console.error('FATAL: Refusing to create bootstrap admin with weak password in production.');
      process.exit(1);
    }
  }

  const normalizedEmail = normalizeEmail(email);
  const normalizedHandle = normalizeHandle(handle);

  const existing = await query<{ id: string; status: string }>(
    'SELECT id, status FROM users WHERE email = $1 OR handle = $2',
    [normalizedEmail, normalizedHandle]
  );

  if (existing.rows.length > 0) {
    const userId = existing.rows[0].id;
    if (existing.rows[0].status !== 'approved') {
      await query(
        `UPDATE users
         SET status = 'approved',
             approved_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [userId]
      );
    }
    await query(
      `INSERT INTO user_roles (user_id, role)
       VALUES ($1, 'admin')
       ON CONFLICT DO NOTHING`,
      [userId]
    );
    await query(
      `INSERT INTO user_roles (user_id, role)
       VALUES ($1, 'moderator'), ($1, 'user')
       ON CONFLICT DO NOTHING`,
      [userId]
    );
    return;
  }

  const userId = crypto.randomUUID();
  const passwordHash = await hashPassword(password);
  const did = createLocalDid();

  await query(
    `INSERT INTO users (id, handle, email, password_hash, status, did, approved_at)
     VALUES ($1, $2, $3, $4, 'approved', $5, CURRENT_TIMESTAMP)`,
    [userId, normalizedHandle, normalizedEmail, passwordHash, did]
  );

  await query(
    `INSERT INTO user_roles (user_id, role)
     VALUES ($1, 'admin'), ($1, 'moderator'), ($1, 'user')`,
    [userId]
  );

  console.log('✓ Bootstrap admin user created');
}
