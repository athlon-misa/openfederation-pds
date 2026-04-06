/**
 * E2E: Governance Proofs (Cross-Cutting)
 *
 * Tests the governance proof flow with on-chain governance model:
 * community creation with on-chain mode, proof submission via
 * mock adapter, caching, and oracle-trust fallback.
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
const GP_TX_HASH = '0xgov1234567890abcdef';

beforeAll(async () => {
  plcAvailable = await isPLCAvailable();
  if (!plcAvailable) return;

  // Register mock adapter for eip155:31337
  registerAdapter({
    chainId: 'eip155:31337',
    name: 'MockGovernanceChain',
    async verifyProof(_proof: GovernanceProof): Promise<VerificationResult> {
      return { verified: true, blockTimestamp: 1700000000, confirmations: 50 };
    },
  });

  adminToken = await getAdminToken();

  // Create community
  const owner = await createTestUser(uniqueHandle('gp-owner'));
  const createRes = await xrpcAuthPost('net.openfederation.community.create', owner.accessJwt, {
    handle: uniqueHandle('gp-comm'), didMethod: 'plc', visibility: 'public', joinPolicy: 'open',
  });
  communityDid = createRes.body.did;

  // Create Oracle credential first (required before setting on-chain governance)
  oracleKey = await createOracleForCommunity(adminToken, communityDid);

  // Set on-chain governance model
  const govRes = await xrpcAuthPost('net.openfederation.community.setGovernanceModel', owner.accessJwt, {
    communityDid,
    governanceModel: 'on-chain',
    governanceConfig: {
      chainId: 'eip155:31337',
      contractAddress: '0x1234567890abcdef1234567890abcdef12345678',
    },
  });
  if (govRes.status !== 200) {
    console.error('Failed to set governance model:', govRes.body);
  }
});

afterAll(() => {
  clearAdapters();
});

describe('Governance Proofs', () => {
  it('step 1: submit proof -> verified, not cached, on-chain', async () => {
    if (!plcAvailable) return;

    const res = await api
      .post('/xrpc/net.openfederation.oracle.submitProof')
      .set('X-Oracle-Key', oracleKey)
      .send({
        chainId: 'eip155:31337',
        transactionHash: GP_TX_HASH,
      });

    expect(res.status).toBe(200);
    expect(res.body.verified).toBe(true);
    expect(res.body.cached).toBe(false);
    expect(res.body.verificationMethod).toBe('on-chain');
    expect(res.body.blockTimestamp).toBe(1700000000);
    expect(res.body.confirmations).toBe(50);
  });

  it('step 2: same proof -> cached: true', async () => {
    if (!plcAvailable) return;

    const res = await api
      .post('/xrpc/net.openfederation.oracle.submitProof')
      .set('X-Oracle-Key', oracleKey)
      .send({
        chainId: 'eip155:31337',
        transactionHash: GP_TX_HASH,
      });

    expect(res.status).toBe(200);
    expect(res.body.cached).toBe(true);
    expect(res.body.verificationMethod).toBe('cache');
  });

  it('step 3: unregistered chain -> oracle-trust', async () => {
    if (!plcAvailable) return;

    const res = await api
      .post('/xrpc/net.openfederation.oracle.submitProof')
      .set('X-Oracle-Key', oracleKey)
      .send({
        chainId: 'eip155:88888',
        transactionHash: '0xunique-governance-hash',
      });

    expect(res.status).toBe(200);
    expect(res.body.verified).toBe(true);
    expect(res.body.cached).toBe(false);
    expect(res.body.verificationMethod).toBe('oracle-trust');
  });
});
