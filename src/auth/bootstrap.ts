import { config } from '../config.js';
import { withTransaction } from '../db/client.js';
import type { AuditAction } from '../db/audit.js';
import { hashPassword } from './password.js';
import { createLocalDid, isStrongPassword, normalizeEmail, normalizeHandle, passwordValidationMessage } from './utils.js';
import crypto from 'crypto';
import type { QueryResult } from 'pg';

const REPOSITORY_KNOWN_BOOTSTRAP_PASSWORDS = new Set([
  'AdminPass1234',
]);

type BootstrapQuery = <T extends Record<string, unknown> = Record<string, unknown>>(
  text: string,
  params?: unknown[],
) => Promise<QueryResult<T>>;

interface BootstrapTransactionClient {
  query: BootstrapQuery;
}

export type BootstrapTransaction = <T>(
  operation: (client: BootstrapTransactionClient) => Promise<T>,
) => Promise<T>;

const runBootstrapTransaction: BootstrapTransaction = (operation) =>
  withTransaction((client) => operation({
    query: <T extends Record<string, unknown>>(
      text: string,
      params?: unknown[],
    ) => client.query<T>(text, params),
  }));

async function insertBootstrapAudit(
  client: BootstrapTransactionClient,
  action: AuditAction,
  targetId: string,
  meta: Record<string, unknown>,
): Promise<void> {
  await client.query(
    `INSERT INTO audit_log (action, actor_id, target_id, meta)
     VALUES ($1, $2, $3, $4)`,
    [action, null, targetId, JSON.stringify(meta)],
  );
}

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

export async function ensureBootstrapAdmin(
  runTransaction: BootstrapTransaction = runBootstrapTransaction,
): Promise<void> {
  validateBootstrapAdminConfig();

  const email = config.auth.bootstrapAdminEmail.trim();
  const handle = config.auth.bootstrapAdminHandle.trim();
  const password = config.auth.bootstrapAdminPassword;

  if (!email && !handle && !password) {
    return;
  }

  const normalizedEmail = normalizeEmail(email);
  const normalizedHandle = normalizeHandle(handle);

  const outcome = await runTransaction(async (client) => {
    // Bootstrap can run concurrently during rolling deploys. Serialize the
    // lookup/create/promote sequence for this one startup-only identity.
    await client.query('SELECT pg_advisory_xact_lock(1868982375)');

    const existing = await client.query<{ id: string; status: string; email: string; handle: string }>(
      'SELECT id, status, email, handle FROM users WHERE email = $1 OR handle = $2',
      [normalizedEmail, normalizedHandle],
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
      const approval = await client.query<{ id: string; handle: string; email: string }>(
        `UPDATE users
         SET status = 'approved',
             approved_at = CURRENT_TIMESTAMP
         WHERE id = $1
           AND status <> 'approved'
         RETURNING id, handle, email`,
        [userId],
      );
      if (approval.rows.length > 0) {
        await insertBootstrapAudit(client, 'account.approve', userId, {
          source: 'bootstrap',
          actor: 'system/bootstrap',
          handle: approval.rows[0].handle,
          email: approval.rows[0].email,
        });
      }
      const grantedRoles = await client.query<{ role: string }>(
        `INSERT INTO user_roles (user_id, role)
         VALUES ($1, 'admin'), ($1, 'moderator'), ($1, 'partner-manager'), ($1, 'auditor'), ($1, 'user')
         ON CONFLICT DO NOTHING
         RETURNING role`,
        [userId],
      );
      if (grantedRoles.rows.length > 0) {
        await insertBootstrapAudit(client, 'account.roles.update', userId, {
          source: 'bootstrap',
          actor: 'system/bootstrap',
          roles: grantedRoles.rows.map(({ role }) => role),
          operation: 'grant',
        });
      }
      return 'existing' as const;
    }

    const userId = crypto.randomUUID();
    const passwordHash = await hashPassword(password);
    const did = createLocalDid();

    await client.query(
      `INSERT INTO users (id, handle, email, password_hash, status, did, approved_at)
       VALUES ($1, $2, $3, $4, 'approved', $5, CURRENT_TIMESTAMP)`,
      [userId, normalizedHandle, normalizedEmail, passwordHash, did],
    );
    await insertBootstrapAudit(client, 'account.register', userId, {
      source: 'bootstrap',
      actor: 'system/bootstrap',
      handle: normalizedHandle,
      email: normalizedEmail,
      did,
      status: 'approved',
    });

    const grantedRoles = await client.query<{ role: string }>(
      `INSERT INTO user_roles (user_id, role)
       VALUES ($1, 'admin'), ($1, 'moderator'), ($1, 'partner-manager'), ($1, 'auditor'), ($1, 'user')
       ON CONFLICT DO NOTHING
       RETURNING role`,
      [userId],
    );
    if (grantedRoles.rows.length > 0) {
      await insertBootstrapAudit(client, 'account.roles.update', userId, {
        source: 'bootstrap',
        actor: 'system/bootstrap',
        roles: grantedRoles.rows.map(({ role }) => role),
        operation: 'grant',
      });
    }
    return 'created' as const;
  });

  if (outcome === 'existing') {
    console.warn(
      'WARNING: BOOTSTRAP_ADMIN_PASSWORD is still set in your environment. ' +
      'The admin account already exists — remove this variable to reduce your attack surface.',
    );
  } else {
    console.log('✓ Bootstrap admin user created');
  }
}
