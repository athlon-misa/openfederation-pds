/**
 * Security Regression Tests: Bootstrap administrator
 *
 * Exercises bootstrap startup behavior without a database by injecting the
 * query boundary. The production default remains the real PostgreSQL query.
 */

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import dotenv from 'dotenv';
import { config } from '../src/config.js';
import { ensureBootstrapAdmin } from '../src/auth/bootstrap.js';

type BootstrapQuery = (text: string, params?: unknown[]) => Promise<{
  rows: Array<Record<string, unknown>>;
  rowCount: number;
}>;

type BootstrapAudit = (
  action: string,
  actorId: string | null,
  targetId: string | null,
  meta?: Record<string, unknown>,
) => Promise<void>;

type BootstrapTransaction = (
  operation: (client: { query: BootstrapQuery }) => Promise<void>,
) => Promise<void>;

interface BootstrapHarnessState {
  user: {
    id: string;
    handle: string;
    email: string;
    status: string;
  } | null;
  roles: string[];
  audits: string[];
}

const originalBootstrapConfig = {
  email: config.auth.bootstrapAdminEmail,
  handle: config.auth.bootstrapAdminHandle,
  password: config.auth.bootstrapAdminPassword,
  nodeEnv: config.env.nodeEnv,
  isProduction: config.env.isProduction,
};

function setBootstrapConfig(password: string): void {
  config.auth.bootstrapAdminEmail = 'operator@example.com';
  config.auth.bootstrapAdminHandle = 'bootstrap-operator';
  config.auth.bootstrapAdminPassword = password;
}

async function runBootstrap(query: BootstrapQuery, audit?: BootstrapAudit): Promise<void> {
  const transaction: BootstrapTransaction = async (operation) => {
    const transactionQuery: BootstrapQuery = async (text, params = []) => {
      if (text.includes('pg_advisory_xact_lock')) {
        return { rows: [], rowCount: 1 };
      }
      if (text.includes('INSERT INTO audit_log')) {
        const meta = params[3] ? JSON.parse(String(params[3])) as Record<string, unknown> : undefined;
        await audit?.(
          String(params[0]),
          params[1] === null ? null : String(params[1]),
          params[2] === null ? null : String(params[2]),
          meta,
        );
        return { rows: [], rowCount: 1 };
      }
      return query(text, params);
    };

    await operation({ query: transactionQuery });
  };

  await runTransactionalBootstrap(transaction);
}

async function runTransactionalBootstrap(transaction: BootstrapTransaction): Promise<void> {
  await (ensureBootstrapAdmin as unknown as (
    transaction: BootstrapTransaction,
  ) => Promise<void>)(transaction);
}

function createTransactionHarness(
  initial: BootstrapHarnessState,
  failAuditAction?: string,
): {
  transaction: BootstrapTransaction;
  state: () => BootstrapHarnessState;
} {
  let committed = structuredClone(initial);

  const transaction: BootstrapTransaction = async (operation) => {
    const working = structuredClone(committed);
    const query: BootstrapQuery = async (text, params = []) => {
      if (text.includes('pg_advisory_xact_lock')) {
        return { rows: [], rowCount: 1 };
      }
      if (text.includes('FROM users')) {
        const email = String(params[0]);
        const handle = String(params[1]);
        const rows = working.user
          && (working.user.email === email || working.user.handle === handle)
          ? [working.user]
          : [];
        return { rows, rowCount: rows.length };
      }
      if (text.trimStart().startsWith('INSERT INTO users')) {
        working.user = {
          id: String(params[0]),
          handle: String(params[1]),
          email: String(params[2]),
          status: 'approved',
        };
        return { rows: [], rowCount: 1 };
      }
      if (text.trimStart().startsWith('UPDATE users')) {
        if (!working.user || working.user.status === 'approved') {
          return { rows: [], rowCount: 0 };
        }
        working.user.status = 'approved';
        return { rows: [working.user], rowCount: 1 };
      }
      if (text.includes('INSERT INTO user_roles')) {
        const granted = ['admin', 'moderator', 'partner-manager', 'auditor', 'user']
          .filter((role) => !working.roles.includes(role));
        working.roles.push(...granted);
        return {
          rows: granted.map((role) => ({ role })),
          rowCount: granted.length,
        };
      }
      if (text.includes('INSERT INTO audit_log')) {
        const action = String(params[0]);
        if (action === failAuditAction) {
          throw new Error(`strict audit insert failed for ${action}`);
        }
        working.audits.push(action);
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected bootstrap query: ${text}`);
    };

    await operation({ query });
    committed = working;
  };

  return {
    transaction,
    state: () => structuredClone(committed),
  };
}

afterEach(() => {
  config.auth.bootstrapAdminEmail = originalBootstrapConfig.email;
  config.auth.bootstrapAdminHandle = originalBootstrapConfig.handle;
  config.auth.bootstrapAdminPassword = originalBootstrapConfig.password;
  config.env.nodeEnv = originalBootstrapConfig.nodeEnv;
  config.env.isProduction = originalBootstrapConfig.isProduction;
});

describe('Bootstrap administrator configuration', () => {
  it('keeps the example bootstrap deployment database password empty so Compose requires an explicit value', () => {
    const example = dotenv.parse(readFileSync('.env.example'));

    assert.equal(example.DB_PASSWORD, '');
  });

  it('keeps CI bootstrap credentials strong and consistent with integration-test expectations', () => {
    const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
    const expectedPassword = 'Bootstrap-Test-Password-47!';

    assert.equal(workflow.includes('AdminPass1234'), false);
    assert.equal(
      workflow.match(new RegExp(`BOOTSTRAP_ADMIN_PASSWORD: ${expectedPassword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'g'))?.length,
      2,
    );
    assert.equal(readFileSync('tests/api/setup.ts', 'utf8').includes(expectedPassword), true);
    assert.equal(readFileSync('tests/api/helpers.ts', 'utf8').includes(expectedPassword), true);
  });

  it('locks down Docker Compose production credentials without repository-known defaults', () => {
    const compose = readFileSync('docker-compose.yml', 'utf8');

    assert.match(compose, /^\s+NODE_ENV: production$/m);
    assert.match(compose, /\$\{DB_PASSWORD:\?Set DB_PASSWORD in \.env\}/);
    assert.match(compose, /\$\{BOOTSTRAP_ADMIN_EMAIL:\?Set BOOTSTRAP_ADMIN_EMAIL in \.env\}/);
    assert.match(compose, /\$\{BOOTSTRAP_ADMIN_HANDLE:\?Set BOOTSTRAP_ADMIN_HANDLE in \.env\}/);
    assert.match(
      compose,
      /\$\{BOOTSTRAP_ADMIN_PASSWORD:\?Set a unique BOOTSTRAP_ADMIN_PASSWORD in \.env\}/,
    );
    assert.equal(compose.includes('AdminPass1234'), false);
  });

  it('validates bootstrap configuration before startup checks database connectivity', () => {
    const server = readFileSync('src/server/index.ts', 'utf8');
    const startup = server.slice(server.indexOf('export async function startServer'));
    const validation = startup.indexOf('validateBootstrapAdminConfig();');
    const connectivity = startup.indexOf('await testConnection()');

    assert.notEqual(validation, -1, 'server startup must explicitly validate bootstrap configuration');
    assert.notEqual(connectivity, -1);
    assert.ok(validation < connectivity, 'bootstrap validation must precede the database connectivity gate');
  });

  it('documents every privileged bootstrap role in Railway deployment guidance', () => {
    const railway = readFileSync('RAILWAY.md', 'utf8');

    assert.match(
      railway,
      /admin \+ moderator \+ partner-manager \+ auditor \+ user roles/,
    );
  });

  it('rejects the repository-known bootstrap password in every environment', async () => {
    const unexpectedQuery: BootstrapQuery = async () => {
      throw new Error('Database lookup occurred before bootstrap validation');
    };

    for (const [nodeEnv, isProduction] of [
      ['development', false],
      ['production', true],
    ] as const) {
      config.env.nodeEnv = nodeEnv;
      config.env.isProduction = isProduction;
      setBootstrapConfig('AdminPass1234');

      await assert.rejects(
        () => runBootstrap(unexpectedQuery),
        /bootstrap admin password.*known/i,
      );
    }
  });

  it('rejects weak bootstrap passwords before any database access', async () => {
    setBootstrapConfig('weak');

    await assert.rejects(
      () => runBootstrap(async () => {
        throw new Error('Database lookup occurred before bootstrap validation');
      }),
      /bootstrap admin password.*strength/i,
    );
  });

  it('does not promote a bootstrap account when only email matches', async () => {
    setBootstrapConfig('Unique-Bootstrap-Password-47!');
    let mutationAttempted = false;

    const partialMatchQuery: BootstrapQuery = async (text) => {
      if (text.trimStart().startsWith('SELECT')) {
        return {
          rows: [{
            id: 'preclaimed-account',
            status: 'pending',
            email: 'operator@example.com',
            handle: 'someone-else',
          }],
          rowCount: 1,
        };
      }

      mutationAttempted = true;
      return { rows: [], rowCount: 0 };
    };

    await assert.rejects(
      () => runBootstrap(partialMatchQuery),
      /bootstrap admin identifier mismatch/i,
    );
    assert.equal(mutationAttempted, false);
  });

  it('does not promote a bootstrap account when only handle matches', async () => {
    setBootstrapConfig('Unique-Bootstrap-Password-47!');
    let mutationAttempted = false;

    const handleOnlyMatchQuery: BootstrapQuery = async (text) => {
      if (text.trimStart().startsWith('SELECT')) {
        return {
          rows: [{
            id: 'preclaimed-account',
            status: 'pending',
            email: 'someone-else@example.com',
            handle: 'bootstrap-operator',
          }],
          rowCount: 1,
        };
      }

      mutationAttempted = true;
      return { rows: [], rowCount: 0 };
    };

    await assert.rejects(
      () => runBootstrap(handleOnlyMatchQuery),
      /bootstrap admin identifier mismatch/i,
    );
    assert.equal(mutationAttempted, false);
  });
});

describe('Bootstrap administrator audit trail', () => {
  it('rolls back a newly created account and roles when a strict audit insert fails', async () => {
    setBootstrapConfig('Unique-Bootstrap-Password-47!');
    const harness = createTransactionHarness({
      user: null,
      roles: [],
      audits: [],
    }, 'account.roles.update');

    await assert.rejects(
      () => runTransactionalBootstrap(harness.transaction),
      /strict audit insert failed for account\.roles\.update/,
    );

    assert.deepEqual(harness.state(), {
      user: null,
      roles: [],
      audits: [],
    });
  });

  it('rolls back existing-account approval and roles when a strict audit insert fails', async () => {
    setBootstrapConfig('Unique-Bootstrap-Password-47!');
    const initial: BootstrapHarnessState = {
      user: {
        id: 'existing-account',
        handle: 'bootstrap-operator',
        email: 'operator@example.com',
        status: 'pending',
      },
      roles: [],
      audits: [],
    };
    const harness = createTransactionHarness(initial, 'account.roles.update');

    await assert.rejects(
      () => runTransactionalBootstrap(harness.transaction),
      /strict audit insert failed for account\.roles\.update/,
    );

    assert.deepEqual(harness.state(), initial);
  });

  it('commits bootstrap state and audit rows once across successful idempotent runs', async () => {
    setBootstrapConfig('Unique-Bootstrap-Password-47!');
    const harness = createTransactionHarness({
      user: null,
      roles: [],
      audits: [],
    });

    await runTransactionalBootstrap(harness.transaction);
    await runTransactionalBootstrap(harness.transaction);

    const state = harness.state();
    assert.equal(state.user?.status, 'approved');
    assert.deepEqual(
      [...state.roles].sort(),
      ['admin', 'auditor', 'moderator', 'partner-manager', 'user'],
    );
    assert.deepEqual(state.audits, ['account.register', 'account.roles.update']);
  });

  it('awaits bootstrap account registration audit before assigning roles', async () => {
    setBootstrapConfig('Unique-Bootstrap-Password-47!');
    let roleInsertionStarted = false;

    const creationQuery: BootstrapQuery = async (text) => {
      if (text.trimStart().startsWith('SELECT')) {
        return { rows: [], rowCount: 0 };
      }
      if (text.includes('INSERT INTO user_roles')) {
        roleInsertionStarted = true;
        return {
          rows: ['admin', 'moderator', 'partner-manager', 'auditor', 'user']
            .map((role) => ({ role })),
          rowCount: 5,
        };
      }
      return { rows: [], rowCount: 1 };
    };

    let releaseRegistrationAudit!: () => void;
    const registrationAuditGate = new Promise<void>((resolve) => {
      releaseRegistrationAudit = resolve;
    });
    let registrationAuditStarted!: () => void;
    const registrationAuditStart = new Promise<void>((resolve) => {
      registrationAuditStarted = resolve;
    });

    const audit: BootstrapAudit = async (action) => {
      if (action === 'account.register') {
        registrationAuditStarted();
        await registrationAuditGate;
      }
    };

    let bootstrapCompleted = false;
    const bootstrap = runBootstrap(creationQuery, audit).then(() => {
      bootstrapCompleted = true;
    });
    const firstCompletion = await Promise.race([
      registrationAuditStart.then(() => 'audit-started' as const),
      bootstrap.then(() => 'bootstrap-completed' as const),
    ]);

    assert.equal(firstCompletion, 'audit-started');
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(bootstrapCompleted, false, 'bootstrap must await the registration audit write');
    assert.equal(roleInsertionStarted, false, 'roles must not be assigned before registration is audited');

    releaseRegistrationAudit();
    await bootstrap;

    assert.equal(roleInsertionStarted, true);
  });

  it('awaits bootstrap privileged-role assignment audit before completing', async () => {
    setBootstrapConfig('Unique-Bootstrap-Password-47!');
    let createdUserId = '';
    const auditRecords: Array<{
      action: string;
      actorId: string | null;
      targetId: string | null;
      meta?: Record<string, unknown>;
    }> = [];

    const creationQuery: BootstrapQuery = async (text, params = []) => {
      if (text.trimStart().startsWith('SELECT')) {
        return { rows: [], rowCount: 0 };
      }
      if (text.includes('INSERT INTO users')) {
        createdUserId = String(params[0]);
      }
      if (text.includes('INSERT INTO user_roles')) {
        return {
          rows: ['admin', 'moderator', 'partner-manager', 'auditor', 'user']
            .map((role) => ({ role })),
          rowCount: 5,
        };
      }
      return { rows: [], rowCount: 1 };
    };

    let releaseRoleAudit!: () => void;
    const roleAuditGate = new Promise<void>((resolve) => {
      releaseRoleAudit = resolve;
    });
    let roleAuditStarted!: () => void;
    const roleAuditStart = new Promise<void>((resolve) => {
      roleAuditStarted = resolve;
    });

    const audit: BootstrapAudit = async (action, actorId, targetId, meta) => {
      if (action === 'account.roles.update') {
        roleAuditStarted();
        await roleAuditGate;
      }
      auditRecords.push({ action, actorId, targetId, meta });
    };

    let bootstrapCompleted = false;
    const bootstrap = runBootstrap(creationQuery, audit).then(() => {
      bootstrapCompleted = true;
    });
    const firstCompletion = await Promise.race([
      roleAuditStart.then(() => 'audit-started' as const),
      bootstrap.then(() => 'bootstrap-completed' as const),
    ]);

    assert.equal(firstCompletion, 'audit-started');
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(bootstrapCompleted, false, 'bootstrap must await the role audit write');

    releaseRoleAudit();
    await bootstrap;

    assert.equal(createdUserId.length > 0, true);
    assert.deepEqual(
      auditRecords.map(({ action, actorId, targetId }) => ({ action, actorId, targetId })),
      [
        { action: 'account.register', actorId: null, targetId: createdUserId },
        { action: 'account.roles.update', actorId: null, targetId: createdUserId },
      ],
    );
    assert.equal(auditRecords[0].meta?.source, 'bootstrap');
    assert.equal(auditRecords[1].meta?.source, 'bootstrap');
    assert.deepEqual(
      auditRecords[1].meta?.roles,
      ['admin', 'moderator', 'partner-manager', 'auditor', 'user'],
    );
  });

  it('audits bootstrap existing-account approval and privileged-role assignment', async () => {
    setBootstrapConfig('Unique-Bootstrap-Password-47!');
    const auditRecords: Array<{
      action: string;
      actorId: string | null;
      targetId: string | null;
      meta?: Record<string, unknown>;
    }> = [];

    const exactMatchQuery: BootstrapQuery = async (text) => {
      if (text.trimStart().startsWith('SELECT')) {
        return {
          rows: [{
            id: 'existing-account',
            status: 'pending',
            email: 'operator@example.com',
            handle: 'bootstrap-operator',
          }],
          rowCount: 1,
        };
      }
      if (text.trimStart().startsWith('UPDATE users')) {
        return {
          rows: [{
            id: 'existing-account',
            email: 'operator@example.com',
            handle: 'bootstrap-operator',
          }],
          rowCount: 1,
        };
      }
      if (text.includes('INSERT INTO user_roles')) {
        return {
          rows: ['admin', 'moderator', 'partner-manager', 'auditor', 'user']
            .map((role) => ({ role })),
          rowCount: 5,
        };
      }
      return { rows: [], rowCount: 1 };
    };

    await runBootstrap(exactMatchQuery, async (action, actorId, targetId, meta) => {
      auditRecords.push({ action, actorId, targetId, meta });
    });

    assert.deepEqual(
      auditRecords.map(({ action, actorId, targetId }) => ({ action, actorId, targetId })),
      [
        { action: 'account.approve', actorId: null, targetId: 'existing-account' },
        { action: 'account.roles.update', actorId: null, targetId: 'existing-account' },
      ],
    );
    assert.equal(auditRecords[0].meta?.source, 'bootstrap');
    assert.equal(auditRecords[1].meta?.source, 'bootstrap');
    assert.deepEqual(
      auditRecords[1].meta?.roles,
      ['admin', 'moderator', 'partner-manager', 'auditor', 'user'],
    );
  });

  it('does not audit bootstrap approval when the conditional update changes no row', async () => {
    setBootstrapConfig('Unique-Bootstrap-Password-47!');
    const auditRecords: string[] = [];

    const staleLookupQuery: BootstrapQuery = async (text) => {
      if (text.trimStart().startsWith('SELECT')) {
        return {
          rows: [{
            id: 'concurrently-changed-account',
            status: 'pending',
            email: 'operator@example.com',
            handle: 'bootstrap-operator',
          }],
          rowCount: 1,
        };
      }
      if (text.trimStart().startsWith('UPDATE users')) {
        return { rows: [], rowCount: 0 };
      }
      if (text.includes('INSERT INTO user_roles')) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    };

    await runBootstrap(staleLookupQuery, async (action) => {
      auditRecords.push(action);
    });

    assert.deepEqual(auditRecords, []);
  });

  it('audits bootstrap approval from the conditional update result, not lookup status', async () => {
    setBootstrapConfig('Unique-Bootstrap-Password-47!');
    const auditRecords: string[] = [];

    const concurrentChangeQuery: BootstrapQuery = async (text) => {
      if (text.trimStart().startsWith('SELECT')) {
        return {
          rows: [{
            id: 'concurrently-changed-account',
            status: 'approved',
            email: 'operator@example.com',
            handle: 'bootstrap-operator',
          }],
          rowCount: 1,
        };
      }
      if (text.trimStart().startsWith('UPDATE users')) {
        return {
          rows: [{
            id: 'concurrently-changed-account',
            email: 'operator@example.com',
            handle: 'bootstrap-operator',
          }],
          rowCount: 1,
        };
      }
      if (text.includes('INSERT INTO user_roles')) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    };

    await runBootstrap(concurrentChangeQuery, async (action) => {
      auditRecords.push(action);
    });

    assert.deepEqual(auditRecords, ['account.approve']);
  });

  it('does not audit a bootstrap role transition when no role was inserted', async () => {
    setBootstrapConfig('Unique-Bootstrap-Password-47!');
    const auditRecords: string[] = [];

    const idempotentQuery: BootstrapQuery = async (text) => {
      if (text.trimStart().startsWith('SELECT')) {
        return {
          rows: [{
            id: 'existing-account',
            status: 'approved',
            email: 'operator@example.com',
            handle: 'bootstrap-operator',
          }],
          rowCount: 1,
        };
      }
      if (text.includes('INSERT INTO user_roles')) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 1 };
    };

    await runBootstrap(idempotentQuery, async (action) => {
      auditRecords.push(action);
    });

    assert.deepEqual(auditRecords, []);
  });
});
