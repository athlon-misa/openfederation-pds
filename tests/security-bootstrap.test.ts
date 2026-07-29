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
  await (ensureBootstrapAdmin as unknown as (
    query: BootstrapQuery,
    audit?: BootstrapAudit,
  ) => Promise<void>)(query, audit);
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
  it('awaits bootstrap audit records for new-account creation and privileged-role assignment', async () => {
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
