/**
 * The chain adapter answers "verified" only for what it actually checked, and
 * never repeats the RPC endpoint (which carries the API key) in an error.
 */
import { describe, it, expect } from 'vitest';
import { createEvmAdapter } from '../../src/modules/chain/evm-adapter.js';

const TX = '0x' + 'ab'.repeat(32);
const receipt = { status: 1, to: '0x00000000000000000000000000000000000000c1', blockNumber: 100 };

function adapterWith(provider: Record<string, unknown>) {
  return createEvmAdapter('eip155:1', 'test', 'https://rpc.example/v2/SECRET-API-KEY', provider as never);
}

describe('EVM proof adapter', () => {
  it('does not verify a transaction whose confirmation depth could not be read', async () => {
    const adapter = adapterWith({
      getTransactionReceipt: async () => receipt,
      getBlock: async () => { throw new Error('upstream timeout'); },
      getBlockNumber: async () => { throw new Error('upstream timeout'); },
    });
    const result = await adapter.verifyProof({ chainId: 'eip155:1', transactionHash: TX });
    expect(result.verified).toBe(false);
    expect(result.error).toMatch(/confirm/i);
  });

  it('does not verify a transaction that is not yet deep enough', async () => {
    const adapter = adapterWith({
      getTransactionReceipt: async () => receipt,
      getBlock: async () => ({ timestamp: 1700000000 }),
      getBlockNumber: async () => 101,
    });
    const result = await adapter.verifyProof({ chainId: 'eip155:1', transactionHash: TX });
    expect(result.verified).toBe(false);
  });

  it('verifies a successful, sufficiently confirmed transaction', async () => {
    const adapter = adapterWith({
      getTransactionReceipt: async () => receipt,
      getBlock: async () => ({ timestamp: 1700000000 }),
      getBlockNumber: async () => 200,
    });
    const result = await adapter.verifyProof({ chainId: 'eip155:1', transactionHash: TX });
    expect(result.verified).toBe(true);
    expect(result.confirmations).toBe(101);
  });

  it('never puts the RPC URL or its key into an error', async () => {
    const adapter = adapterWith({
      getTransactionReceipt: async () => {
        throw new Error('server response 401 Unauthorized (request={ }, info={ "requestUrl": "https://rpc.example/v2/SECRET-API-KEY" }, code=SERVER_ERROR)');
      },
    });
    const result = await adapter.verifyProof({ chainId: 'eip155:1', transactionHash: TX });
    expect(result.verified).toBe(false);
    expect(result.error).not.toContain('SECRET-API-KEY');
    expect(result.error).not.toContain('rpc.example');
  });
});
