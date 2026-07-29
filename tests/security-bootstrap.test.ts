/**
 * Security Regression Tests: Bootstrap administrator
 *
 * Exercises bootstrap startup behavior without a database by injecting the
 * query boundary. The production default remains the real PostgreSQL query.
 */

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { ensureBootstrapAdmin } from '../src/auth/bootstrap.js';

type BootstrapQuery = (text: string, params?: unknown[]) => Promise<{
  rows: Array<Record<string, unknown>>;
  rowCount: number;
}>;

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

async function runBootstrap(query: BootstrapQuery): Promise<void> {
  await (ensureBootstrapAdmin as unknown as (query: BootstrapQuery) => Promise<void>)(query);
}

afterEach(() => {
  config.auth.bootstrapAdminEmail = originalBootstrapConfig.email;
  config.auth.bootstrapAdminHandle = originalBootstrapConfig.handle;
  config.auth.bootstrapAdminPassword = originalBootstrapConfig.password;
  config.env.nodeEnv = originalBootstrapConfig.nodeEnv;
  config.env.isProduction = originalBootstrapConfig.isProduction;
});

describe('Bootstrap administrator configuration', () => {
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

  it('does not promote a bootstrap account when only email or handle matches', async () => {
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
});
