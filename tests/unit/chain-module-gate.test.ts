import { describe, it, expect, afterEach } from 'vitest';
import { isChainModuleEnabled, setChainModuleEnabledForTests } from '../../src/config.js';
import { handlerRegistry } from '../../src/server/handler-registry.js';

const ORACLE_NSIDS = [
  'net.openfederation.oracle.createCredential',
  'net.openfederation.oracle.listCredentials',
  'net.openfederation.oracle.revokeCredential',
  'net.openfederation.oracle.submitProof',
] as const;

describe('isChainModuleEnabled()', () => {
  afterEach(() => {
    setChainModuleEnabledForTests(undefined);
  });

  it('is disabled by default in the test environment (no CHAIN_ADAPTERS set)', () => {
    // Test setup does not set CHAIN_ADAPTERS or GOVERNANCE_CHAIN_ENABLED.
    expect(isChainModuleEnabled()).toBe(false);
  });

  it('can be forced on for tests without touching process.env', () => {
    setChainModuleEnabledForTests(true);
    expect(isChainModuleEnabled()).toBe(true);
  });

  it('can be forced off for tests', () => {
    setChainModuleEnabledForTests(false);
    expect(isChainModuleEnabled()).toBe(false);
  });

  it('restores env-driven behavior when the override is cleared', () => {
    setChainModuleEnabledForTests(true);
    expect(isChainModuleEnabled()).toBe(true);
    setChainModuleEnabledForTests(undefined);
    expect(isChainModuleEnabled()).toBe(false);
  });
});

describe('handler registry: oracle endpoint gating', () => {
  it('registers all four oracle endpoints with an enabledWhen guard', () => {
    for (const nsid of ORACLE_NSIDS) {
      const entry = handlerRegistry[nsid];
      expect(entry, `${nsid} should be registered`).toBeDefined();
      expect(typeof entry?.enabledWhen, `${nsid} should have an enabledWhen guard`).toBe('function');
    }
  });

  afterEach(() => {
    setChainModuleEnabledForTests(undefined);
  });

  it('enabledWhen reflects isChainModuleEnabled() at call time', () => {
    setChainModuleEnabledForTests(false);
    for (const nsid of ORACLE_NSIDS) {
      expect(handlerRegistry[nsid]?.enabledWhen?.()).toBe(false);
    }

    setChainModuleEnabledForTests(true);
    for (const nsid of ORACLE_NSIDS) {
      expect(handlerRegistry[nsid]?.enabledWhen?.()).toBe(true);
    }
  });

  it('non-oracle endpoints have no enabledWhen guard (unconditional registration)', () => {
    expect(handlerRegistry['com.atproto.server.createSession']?.enabledWhen).toBeUndefined();
    expect(handlerRegistry['net.openfederation.community.create']?.enabledWhen).toBeUndefined();
  });
});
