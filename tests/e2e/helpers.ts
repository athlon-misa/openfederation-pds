// Re-export everything from api helpers
export {
  xrpcPost, xrpcGet, xrpcAuthPost, xrpcAuthGet,
  getAdminToken, createTestUser, isPLCAvailable, uniqueHandle,
} from '../api/helpers.js';

import { xrpcAuthPost, createTestUser, uniqueHandle } from '../api/helpers.js';

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
  await xrpcAuthPost('net.openfederation.community.join', member.accessJwt, { communityDid });
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
  return res.body.key;
}
