/**
 * A governance proof is a transaction on the community's own governance
 * contract, not any successful transaction on the chain. The contract is the
 * community's setting; the oracle cannot name a different one.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { xrpcPost, xrpcAuthPost, createTestUser, getAdminToken, isPLCAvailable, uniqueHandle } from './helpers.js';
import { query } from '../../src/db/client.js';
import { registerAttestor, clearAttestors, type GovernanceProof } from '../../src/governance/attestor.js';
import { setChainModuleEnabledForTests } from '../../src/config.js';
import { checkGovernanceSettings } from '../../src/governance/settings-rules.js';

const CHAIN = 'eip155:55555';
const CONTRACT = '0x00000000000000000000000000000000000000c1';

describe('governance proofs are bound to the community contract', () => {
  let plc: boolean;
  let communityDid: string;
  let oracleKey: string;
  let seen: GovernanceProof[] = [];

  beforeAll(async () => {
    plc = await isPLCAvailable();
    if (!plc) return;
    setChainModuleEnabledForTests(true);
    const owner = await createTestUser(uniqueHandle('pcb-owner'));
    const created = await xrpcAuthPost('net.openfederation.community.create', owner.accessJwt, {
      handle: uniqueHandle('pcb'), didMethod: 'plc', visibility: 'public', joinPolicy: 'open',
    });
    communityDid = created.body.did;
    const cred = await xrpcAuthPost('net.openfederation.oracle.createCredential', await getAdminToken(), { communityDid, name: 'pcb' });
    oracleKey = cred.body.key;
  });
  afterEach(() => { clearAttestors(); seen = []; });

  const setContract = (contractAddress: string | null, chainId = CHAIN) => query(
    `UPDATE records_index SET record = jsonb_set(record, '{governanceConfig}',
       COALESCE(record->'governanceConfig', '{}'::jsonb) || $2::jsonb)
     WHERE community_did = $1 AND collection = 'net.openfederation.community.settings' AND rkey = 'self'`,
    [communityDid, JSON.stringify(contractAddress ? { contractAddress, chainId } : { contractAddress: null })]);
  const verifyingAdapter = () => registerAttestor({
    chainId: CHAIN, name: 'recording',
    verifyProof: async (proof) => { seen.push(proof); return { verified: true, confirmations: 10 }; },
  });
  const submit = (body: Record<string, unknown>) =>
    xrpcPost('net.openfederation.oracle.submitProof', { chainId: CHAIN, transactionHash: `0x${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`, ...body })
      .set('X-Oracle-Key', oracleKey);

  it('without a configured contract, nothing is verified', async () => {
    if (!plc) return;
    await setContract(null);
    verifyingAdapter();
    const res = await submit({});
    expect(res.body.verified).toBe(false);
    expect(res.body.error).toMatch(/contract/i);
    expect(seen).toHaveLength(0);
  });

  it('checks the transaction against the community\'s contract, whatever the oracle sends', async () => {
    if (!plc) return;
    await setContract(CONTRACT);
    verifyingAdapter();
    const res = await submit({});
    expect(res.body.verified).toBe(true);
    expect(seen[0].contractAddress).toBe(CONTRACT);
  });

  it('refuses a proof the oracle says is for a different contract', async () => {
    if (!plc) return;
    await setContract(CONTRACT);
    verifyingAdapter();
    const res = await submit({ contractAddress: '0x00000000000000000000000000000000000000ee' });
    expect(res.body.verified).toBe(false);
    expect(seen).toHaveLength(0);
  });

  it('refuses a proof on a chain other than the community\'s', async () => {
    if (!plc) return;
    await setContract(CONTRACT, 'eip155:1');
    verifyingAdapter();
    const res = await submit({});
    expect(res.body.verified).toBe(false);
    expect(seen).toHaveLength(0);
  });

  it('settings validation rejects a malformed contract address', () => {
    expect(checkGovernanceSettings({
      governanceModel: 'on-chain',
      governanceConfig: { quorum: 2, voterRole: 'moderator', chainId: 'eip155:1', contractAddress: 'not-an-address' },
    })?.message).toMatch(/contractAddress/);
    expect(checkGovernanceSettings({
      governanceModel: 'on-chain',
      governanceConfig: { quorum: 2, voterRole: 'moderator', chainId: 'eip155:1', contractAddress: CONTRACT },
    })).toBeNull();
  });
});
