// Re-export everything from api helpers
export {
  xrpcPost, xrpcGet, xrpcAuthPost, xrpcAuthGet,
  getAdminToken, createTestUser, isPLCAvailable, uniqueHandle, testServer,
} from '../api/helpers.js';

import { xrpcAuthPost, createTestUser, uniqueHandle } from '../api/helpers.js';
import { query } from '../../src/db/client.js';

export interface CommunityWithMember {
  communityDid: string;
  owner: { accessJwt: string; did: string; handle: string };
  member: { accessJwt: string; did: string; handle: string };
}

export async function createCommunityWithMember(prefix = 'e2e'): Promise<CommunityWithMember> {
  const owner = await createTestUser(uniqueHandle(`${prefix}-owner`));
  const member = await createTestUser(uniqueHandle(`${prefix}-member`));
  const createRes = await xrpcAuthPost('net.openfederation.community.create', owner.accessJwt, {
    handle: uniqueHandle(`${prefix}-comm`), didMethod: 'plc', visibility: 'public', joinPolicy: 'open',
  });
  const communityDid = createRes.body.did;
  const joinRes = await xrpcAuthPost('net.openfederation.community.join', member.accessJwt, { did: communityDid });
  if (joinRes.status !== 200) {
    throw new Error(`Failed to join test member: ${joinRes.status} ${JSON.stringify(joinRes.body)}`);
  }
  return { communityDid, owner, member };
}

export async function issuePrivateAttestation(
  ownerToken: string, communityDid: string, subjectDid: string, subjectHandle: string,
  claim: Record<string, unknown>, accessPolicy?: Record<string, unknown>,
): Promise<{ rkey: string; commitment: string }> {
  const res = await xrpcAuthPost('net.openfederation.community.issueAttestation', ownerToken, {
    communityDid, subjectDid, subjectHandle, type: 'credential', claim, visibility: 'private', accessPolicy,
  });
  if (res.status !== 200) throw new Error(`Failed to issue private attestation: ${res.status} ${JSON.stringify(res.body)}`);
  return { rkey: res.body.rkey, commitment: res.body.commitment };
}

export async function createOracleForCommunity(adminToken: string, communityDid: string, name = 'E2E Test Oracle'): Promise<string> {
  const res = await xrpcAuthPost('net.openfederation.oracle.createCredential', adminToken, { communityDid, name });
  if (res.status !== 200 && res.status !== 201) throw new Error(`Failed to create Oracle: ${res.status} ${JSON.stringify(res.body)}`);
  await setTestGovernanceContract(communityDid);
  return res.body.key;
}

/**
 * Give a test community a governance contract. An oracle's proofs are checked
 * against the community's own contract (governanceConfig.contractAddress), so
 * a community with an oracle needs one. No chain is pinned: these tests use
 * several test chain ids.
 */
export async function setTestGovernanceContract(communityDid: string, contractAddress = '0x000000000000000000000000000000000000c0de'): Promise<void> {
  await query(
    `UPDATE records_index SET record = jsonb_set(record, '{governanceConfig}',
       COALESCE(record->'governanceConfig', '{}'::jsonb) || jsonb_build_object('contractAddress', $2::text))
     WHERE community_did = $1 AND collection = 'net.openfederation.community.settings' AND rkey = 'self'`,
    [communityDid, contractAddress],
  );
}

