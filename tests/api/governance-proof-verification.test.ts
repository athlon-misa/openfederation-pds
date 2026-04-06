import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import {
  registerAdapter,
  getAdapter,
  listAdapters,
  clearAdapters,
} from '../../src/governance/chain-adapter.js';
import type { ChainAdapter, GovernanceProof, VerificationResult } from '../../src/governance/chain-adapter.js';
import {
  xrpcPost,
  getAdminToken,
  xrpcAuthPost,
  createTestUser,
  isPLCAvailable,
  uniqueHandle,
} from './helpers.js';

// ── Unit Tests: Adapter Registry ─────────────────────────────────

describe('Chain Adapter Registry', () => {
  afterAll(() => {
    clearAdapters();
  });

  it('should register and retrieve an adapter', () => {
    const adapter: ChainAdapter = {
      chainId: 'eip155:1',
      name: 'Ethereum Mainnet',
      verifyProof: async () => ({ verified: true }),
    };
    registerAdapter(adapter);
    expect(getAdapter('eip155:1')).toBe(adapter);
  });

  it('should return undefined for unregistered chain', () => {
    expect(getAdapter('eip155:999999')).toBeUndefined();
  });

  it('should list all registered adapters', () => {
    clearAdapters();
    registerAdapter({
      chainId: 'eip155:1',
      name: 'Ethereum',
      verifyProof: async () => ({ verified: true }),
    });
    registerAdapter({
      chainId: 'eip155:137',
      name: 'Polygon',
      verifyProof: async () => ({ verified: true }),
    });

    const list = listAdapters();
    expect(list).toHaveLength(2);
    expect(list).toEqual(
      expect.arrayContaining([
        { chainId: 'eip155:1', name: 'Ethereum' },
        { chainId: 'eip155:137', name: 'Polygon' },
      ])
    );
  });

  it('should overwrite adapter on duplicate chainId', () => {
    const adapter1: ChainAdapter = {
      chainId: 'eip155:42',
      name: 'Old',
      verifyProof: async () => ({ verified: false }),
    };
    const adapter2: ChainAdapter = {
      chainId: 'eip155:42',
      name: 'New',
      verifyProof: async () => ({ verified: true }),
    };
    registerAdapter(adapter1);
    registerAdapter(adapter2);

    const fetched = getAdapter('eip155:42');
    expect(fetched?.name).toBe('New');
    expect(listAdapters().filter(a => a.chainId === 'eip155:42')).toHaveLength(1);
  });

  it('clearAdapters should remove all adapters', () => {
    registerAdapter({
      chainId: 'eip155:100',
      name: 'Test',
      verifyProof: async () => ({ verified: true }),
    });
    clearAdapters();
    expect(listAdapters()).toHaveLength(0);
    expect(getAdapter('eip155:100')).toBeUndefined();
  });
});

// ── Unit Tests: EVM Adapter with Mock ────────────────────────────

describe('EVM Adapter (mocked)', () => {
  afterAll(() => {
    clearAdapters();
  });

  function createMockEvmAdapter(
    chainId: string,
    mockResult: {
      receipt?: any;
      block?: any;
      blockNumber?: number;
      error?: Error;
    }
  ): ChainAdapter {
    // We create a mock adapter that simulates what the real EVM adapter does
    // without requiring an actual ethers provider / RPC endpoint
    return {
      chainId,
      name: `Mock EVM ${chainId}`,
      async verifyProof(proof: GovernanceProof): Promise<VerificationResult> {
        if (mockResult.error) {
          return { verified: false, error: `RPC error: ${mockResult.error.message}` };
        }

        const receipt = mockResult.receipt;
        if (!receipt) {
          return { verified: false, error: 'Transaction not found on chain' };
        }
        if (receipt.status !== 1) {
          return { verified: false, error: 'Transaction reverted (status !== 1)' };
        }
        if (proof.contractAddress) {
          const expected = proof.contractAddress.toLowerCase();
          const actual = receipt.to?.toLowerCase();
          if (actual !== expected) {
            return {
              verified: false,
              error: `Contract address mismatch: expected ${proof.contractAddress}, got ${receipt.to}`,
            };
          }
        }
        if (proof.blockNumber !== undefined && receipt.blockNumber !== proof.blockNumber) {
          return {
            verified: false,
            error: `Block number mismatch: expected ${proof.blockNumber}, got ${receipt.blockNumber}`,
          };
        }

        return {
          verified: true,
          blockTimestamp: mockResult.block?.timestamp,
          confirmations: mockResult.blockNumber
            ? mockResult.blockNumber - receipt.blockNumber
            : undefined,
        };
      },
    };
  }

  it('should verify a successful transaction', async () => {
    const adapter = createMockEvmAdapter('eip155:137', {
      receipt: {
        status: 1,
        to: '0xContractAddr',
        blockNumber: 100,
      },
      block: { timestamp: 1700000000 },
      blockNumber: 110,
    });

    const result = await adapter.verifyProof({
      chainId: 'eip155:137',
      transactionHash: '0xabc123',
    });

    expect(result.verified).toBe(true);
    expect(result.blockTimestamp).toBe(1700000000);
    expect(result.confirmations).toBe(10);
  });

  it('should reject a reverted transaction', async () => {
    const adapter = createMockEvmAdapter('eip155:1', {
      receipt: { status: 0, to: '0xAddr', blockNumber: 50 },
    });

    const result = await adapter.verifyProof({
      chainId: 'eip155:1',
      transactionHash: '0xreverted',
    });

    expect(result.verified).toBe(false);
    expect(result.error).toContain('reverted');
  });

  it('should reject when tx not found', async () => {
    const adapter = createMockEvmAdapter('eip155:1', {
      receipt: null,
    });

    const result = await adapter.verifyProof({
      chainId: 'eip155:1',
      transactionHash: '0xmissing',
    });

    expect(result.verified).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('should reject on contract address mismatch', async () => {
    const adapter = createMockEvmAdapter('eip155:1', {
      receipt: { status: 1, to: '0xWrongAddr', blockNumber: 100 },
    });

    const result = await adapter.verifyProof({
      chainId: 'eip155:1',
      transactionHash: '0xabc',
      contractAddress: '0xExpectedAddr',
    });

    expect(result.verified).toBe(false);
    expect(result.error).toContain('mismatch');
  });

  it('should reject on block number mismatch', async () => {
    const adapter = createMockEvmAdapter('eip155:1', {
      receipt: { status: 1, to: '0xAddr', blockNumber: 200 },
    });

    const result = await adapter.verifyProof({
      chainId: 'eip155:1',
      transactionHash: '0xabc',
      blockNumber: 100,
    });

    expect(result.verified).toBe(false);
    expect(result.error).toContain('Block number mismatch');
  });

  it('should handle RPC errors gracefully', async () => {
    const adapter = createMockEvmAdapter('eip155:1', {
      error: new Error('connection timeout'),
    });

    const result = await adapter.verifyProof({
      chainId: 'eip155:1',
      transactionHash: '0xabc',
    });

    expect(result.verified).toBe(false);
    expect(result.error).toContain('RPC error');
    expect(result.error).toContain('connection timeout');
  });
});

// ── Integration Tests: submitProof Endpoint ──────────────────────

describe('submitProof Endpoint', () => {
  it('should reject without Oracle key', async () => {
    const res = await xrpcPost('net.openfederation.oracle.submitProof', {
      chainId: 'eip155:1',
      transactionHash: '0xabc123',
    });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('AuthRequired');
  });

  it('should reject with invalid Oracle key', async () => {
    const res = await xrpcPost('net.openfederation.oracle.submitProof', {
      chainId: 'eip155:1',
      transactionHash: '0xabc123',
    }).set('X-Oracle-Key', 'invalid_key');
    expect(res.status).toBe(401);
  });

  it('should reject missing chainId', async () => {
    // Without a valid Oracle key, we either get 401 (key validation fails) or 500 (DB down)
    // With no X-Oracle-Key header at all, we get 401 before any DB call
    const res = await xrpcPost('net.openfederation.oracle.submitProof', {
      transactionHash: '0xabc123',
    });
    expect(res.status).toBe(401);
  });

  it('should reject missing transactionHash', async () => {
    const res = await xrpcPost('net.openfederation.oracle.submitProof', {
      chainId: 'eip155:1',
    });
    expect(res.status).toBe(401);
  });

  // Full flow test with real Oracle key (requires PLC for user creation)
  describe('with real Oracle key', () => {
    let plcAvailable: boolean;
    let adminToken: string;
    let communityDid: string;
    let oracleKey: string;

    beforeAll(async () => {
      plcAvailable = await isPLCAvailable();
      if (!plcAvailable) return;

      const owner = await createTestUser(uniqueHandle('proof-owner'));
      adminToken = await getAdminToken();

      // Create community
      const createRes = await xrpcAuthPost('net.openfederation.community.create', owner.accessJwt, {
        handle: uniqueHandle('proof-comm'),
        didMethod: 'plc',
        visibility: 'public',
        joinPolicy: 'open',
      });
      communityDid = createRes.body.did;

      // Create Oracle credential
      const credRes = await xrpcAuthPost('net.openfederation.oracle.createCredential', adminToken, {
        communityDid,
        name: 'Test Proof Oracle',
      });
      oracleKey = credRes.body.key;
    });

    it('should fall back to oracle-trust when no adapter registered', async () => {
      if (!plcAvailable) return;

      // Clear adapters to ensure no adapter is available
      clearAdapters();

      const res = await xrpcPost('net.openfederation.oracle.submitProof', {
        chainId: 'eip155:99999',
        transactionHash: '0xdeadbeef',
      }).set('X-Oracle-Key', oracleKey);

      expect(res.status).toBe(200);
      expect(res.body.verified).toBe(true);
      expect(res.body.verificationMethod).toBe('oracle-trust');
      expect(res.body.cached).toBe(false);
    });

    it('should return cached result on second call', async () => {
      if (!plcAvailable) return;

      // The previous test cached a result for eip155:99999 / 0xdeadbeef
      const res = await xrpcPost('net.openfederation.oracle.submitProof', {
        chainId: 'eip155:99999',
        transactionHash: '0xdeadbeef',
      }).set('X-Oracle-Key', oracleKey);

      expect(res.status).toBe(200);
      expect(res.body.cached).toBe(true);
      expect(res.body.verificationMethod).toBe('cache');
    });

    it('should verify on-chain when adapter is registered', async () => {
      if (!plcAvailable) return;

      // Register a mock adapter that always verifies
      registerAdapter({
        chainId: 'eip155:77777',
        name: 'Mock Chain',
        verifyProof: async () => ({
          verified: true,
          blockTimestamp: 1700000000,
          confirmations: 42,
        }),
      });

      const res = await xrpcPost('net.openfederation.oracle.submitProof', {
        chainId: 'eip155:77777',
        transactionHash: '0xverified123',
      }).set('X-Oracle-Key', oracleKey);

      expect(res.status).toBe(200);
      expect(res.body.verified).toBe(true);
      expect(res.body.verificationMethod).toBe('on-chain');
      expect(res.body.blockTimestamp).toBe(1700000000);
      expect(res.body.confirmations).toBe(42);
      expect(res.body.cached).toBe(false);

      // Cleanup
      clearAdapters();
    });

    it('should return adapter verification failure', async () => {
      if (!plcAvailable) return;

      registerAdapter({
        chainId: 'eip155:88888',
        name: 'Failing Chain',
        verifyProof: async () => ({
          verified: false,
          error: 'Transaction reverted (status !== 1)',
        }),
      });

      const res = await xrpcPost('net.openfederation.oracle.submitProof', {
        chainId: 'eip155:88888',
        transactionHash: '0xfailed456',
      }).set('X-Oracle-Key', oracleKey);

      expect(res.status).toBe(200);
      expect(res.body.verified).toBe(false);
      expect(res.body.error).toContain('reverted');
      expect(res.body.verificationMethod).toBe('on-chain');

      clearAdapters();
    });
  });
});
