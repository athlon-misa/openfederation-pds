/**
 * E2E: Chain Proof Verification
 *
 * Tests the Oracle proof submission and verification flow including
 * on-chain adapter verification, caching, and oracle-trust fallback.
 * Requires PLC directory.
 */
import { registerAdapter, clearAdapters } from '../../src/governance/chain-adapter.js';
import type { GovernanceProof, VerificationResult } from '../../src/governance/chain-adapter.js';
import {
  isPLCAvailable, getAdminToken, createTestUser, uniqueHandle,
  xrpcAuthPost, createOracleForCommunity,
} from './helpers.js';
import { api } from '../api/helpers.js';

let plcAvailable = false;
let adminToken: string;
let communityDid: string;
let oracleKey: string;
const TX_HASH = '0xdeadbeef1234567890abcdef';

beforeAll(async () => {
  plcAvailable = await isPLCAvailable();
  if (!plcAvailable) return;

  // Register mock adapter for eip155:31337
  registerAdapter({
    chainId: 'eip155:31337',
    name: 'MockLocalnet',
    async verifyProof(_proof: GovernanceProof): Promise<VerificationResult> {
      return { verified: true, blockTimestamp: 1700000000, confirmations: 100 };
    },
  });

  adminToken = await getAdminToken();

  // Create community + oracle credential
  const owner = await createTestUser(uniqueHandle('cpv-owner'));
  const createRes = await xrpcAuthPost('net.openfederation.community.create', owner.accessJwt, {
    handle: uniqueHandle('cpv-comm'), didMethod: 'plc', visibility: 'public', joinPolicy: 'open',
  });
  communityDid = createRes.body.did;
  oracleKey = await createOracleForCommunity(adminToken, communityDid);
});

afterAll(() => {
  clearAdapters();
});

describe('Chain Proof Verification', () => {
  it('step 1: submit proof with registered adapter -> verified, not cached, on-chain', async () => {
    if (!plcAvailable) return;

    const res = await api
      .post('/xrpc/net.openfederation.oracle.submitProof')
      .set('X-Oracle-Key', oracleKey)
      .send({
        chainId: 'eip155:31337',
        transactionHash: TX_HASH,
      });

    expect(res.status).toBe(200);
    expect(res.body.verified).toBe(true);
    expect(res.body.cached).toBe(false);
    expect(res.body.verificationMethod).toBe('on-chain');
    expect(res.body.blockTimestamp).toBe(1700000000);
    expect(res.body.confirmations).toBe(100);
  });

  it('step 2: same proof again -> cached: true', async () => {
    if (!plcAvailable) return;

    const res = await api
      .post('/xrpc/net.openfederation.oracle.submitProof')
      .set('X-Oracle-Key', oracleKey)
      .send({
        chainId: 'eip155:31337',
        transactionHash: TX_HASH,
      });

    expect(res.status).toBe(200);
    expect(res.body.verified).toBe(true);
    expect(res.body.cached).toBe(true);
    expect(res.body.verificationMethod).toBe('cache');
  });

  it('step 3: unregistered chain (no adapter) -> oracle-trust', async () => {
    if (!plcAvailable) return;

    const res = await api
      .post('/xrpc/net.openfederation.oracle.submitProof')
      .set('X-Oracle-Key', oracleKey)
      .send({
        chainId: 'eip155:99999',
        transactionHash: '0xabc123unique',
      });

    expect(res.status).toBe(200);
    expect(res.body.verified).toBe(true);
    expect(res.body.cached).toBe(false);
    expect(res.body.verificationMethod).toBe('oracle-trust');
  });
});
