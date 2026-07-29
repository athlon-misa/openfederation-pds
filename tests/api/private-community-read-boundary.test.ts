import { beforeAll, describe, expect, it } from 'vitest';
import {
  createTestUser,
  getAdminToken,
  isPLCAvailable,
  uniqueHandle,
  xrpcAuthGet,
  xrpcAuthPost,
  xrpcGet,
} from './helpers.js';

describe('private community read boundary', () => {
  let plcAvailable = false;
  let owner: { accessJwt: string; did: string };
  let member: { accessJwt: string; did: string };
  let outsider: { accessJwt: string; did: string };
  let adminToken: string;
  let privateCommunityDid: string;
  let publicCommunityDid: string;
  let proposalRkey: string;

  beforeAll(async () => {
    plcAvailable = await isPLCAvailable();
    if (!plcAvailable) return;

    owner = await createTestUser(uniqueHandle('read-owner'));
    member = await createTestUser(uniqueHandle('read-member'));
    outsider = await createTestUser(uniqueHandle('read-outsider'));
    adminToken = await getAdminToken();

    const privateCreate = await xrpcAuthPost('net.openfederation.community.create', owner.accessJwt, {
      handle: uniqueHandle('read-private'), didMethod: 'plc', visibility: 'private', joinPolicy: 'open',
    });
    expect(privateCreate.status).toBe(201);
    privateCommunityDid = privateCreate.body.did;

    const publicCreate = await xrpcAuthPost('net.openfederation.community.create', owner.accessJwt, {
      handle: uniqueHandle('read-public'), didMethod: 'plc', visibility: 'public', joinPolicy: 'open',
    });
    expect(publicCreate.status).toBe(201);
    publicCommunityDid = publicCreate.body.did;

    expect((await xrpcAuthPost('net.openfederation.community.join', member.accessJwt, {
      did: privateCommunityDid,
    })).status).toBe(200);

    expect((await xrpcAuthPost('net.openfederation.community.setGovernanceModel', owner.accessJwt, {
      communityDid: privateCommunityDid,
      governanceModel: 'simple-majority',
      governanceConfig: { quorum: 1, voterRole: 'member', proposalTtlDays: 7 },
    })).status).toBe(200);

    const proposal = await xrpcAuthPost('net.openfederation.community.createProposal', owner.accessJwt, {
      communityDid: privateCommunityDid,
      targetCollection: 'net.openfederation.community.profile',
      targetRkey: 'self',
      action: 'write',
      proposedRecord: { displayName: 'private proposal' },
    });
    expect(proposal.status).toBe(200);
    proposalRkey = proposal.body.rkey;

    const attestation = await xrpcAuthPost('net.openfederation.community.issueAttestation', owner.accessJwt, {
      communityDid: privateCommunityDid,
      subjectDid: owner.did,
      subjectHandle: 'read-owner',
      type: 'credential',
      claim: { level: 'private' },
      visibility: 'private',
      accessPolicy: { type: 'did-allowlist', dids: [owner.did] },
    });
    expect(attestation.status).toBe(200);
  });

  const privateQueries = () => [
    ['listProposals', (token?: string) => token
      ? xrpcAuthGet('net.openfederation.community.listProposals', token, { communityDid: privateCommunityDid })
      : xrpcGet('net.openfederation.community.listProposals', { communityDid: privateCommunityDid })],
    ['getProposal', (token?: string) => token
      ? xrpcAuthGet('net.openfederation.community.getProposal', token, { communityDid: privateCommunityDid, rkey: proposalRkey })
      : xrpcGet('net.openfederation.community.getProposal', { communityDid: privateCommunityDid, rkey: proposalRkey })],
    ['listRoles', (token?: string) => token
      ? xrpcAuthGet('net.openfederation.community.listRoles', token, { communityDid: privateCommunityDid })
      : xrpcGet('net.openfederation.community.listRoles', { communityDid: privateCommunityDid })],
    ['listAttestations', (token?: string) => token
      ? xrpcAuthGet('net.openfederation.community.listAttestations', token, { communityDid: privateCommunityDid })
      : xrpcGet('net.openfederation.community.listAttestations', { communityDid: privateCommunityDid })],
    ['verifyMembership', (token?: string) => token
      ? xrpcAuthGet('net.openfederation.community.verifyMembership', token, { communityDid: privateCommunityDid, memberDid: owner.did })
      : xrpcGet('net.openfederation.community.verifyMembership', { communityDid: privateCommunityDid, memberDid: owner.did })],
  ] as const;

  it('returns indistinguishable 404s to anonymous and authenticated outsiders', async () => {
    if (!plcAvailable) return;
    for (const [name, request] of privateQueries()) {
      const anonymous = await request();
      const authenticated = await request(outsider.accessJwt);
      expect(anonymous.status, `${name} anonymous`).toBe(404);
      expect(authenticated.status, `${name} outsider`).toBe(404);
      expect(anonymous.body.error).toBe('NotFound');
      expect(authenticated.body.error).toBe('NotFound');
    }
  });

  it('allows members, owners, and PDS admins to read private community surfaces', async () => {
    if (!plcAvailable) return;
    for (const [name, request] of privateQueries()) {
      expect((await request(member.accessJwt)).status, `${name} member`).toBe(200);
      expect((await request(owner.accessJwt)).status, `${name} owner`).toBe(200);
      expect((await request(adminToken)).status, `${name} admin`).toBe(200);
    }
  });

  it('does not expose private attestation metadata to a readable member without disclosure authorization', async () => {
    if (!plcAvailable) return;
    const memberView = await xrpcAuthGet('net.openfederation.community.listAttestations', member.accessJwt, {
      communityDid: privateCommunityDid,
    });
    expect(memberView.status).toBe(200);
    expect(memberView.body.attestations).toEqual([]);

    const ownerView = await xrpcAuthGet('net.openfederation.community.listAttestations', owner.accessJwt, {
      communityDid: privateCommunityDid,
    });
    expect(ownerView.status).toBe(200);
    expect(ownerView.body.attestations).toHaveLength(1);
  });

  it('preserves public response contracts without authentication', async () => {
    if (!plcAvailable) return;
    const cases = await Promise.all([
      xrpcGet('net.openfederation.community.listProposals', { communityDid: publicCommunityDid }),
      xrpcGet('net.openfederation.community.getProposal', { communityDid: publicCommunityDid, rkey: 'missing' }),
      xrpcGet('net.openfederation.community.listRoles', { communityDid: publicCommunityDid }),
      xrpcGet('net.openfederation.community.listAttestations', { communityDid: publicCommunityDid }),
      xrpcGet('net.openfederation.community.verifyMembership', { communityDid: publicCommunityDid, memberDid: outsider.did }),
    ]);
    expect(cases[0].status).toBe(200);
    expect(cases[0].body).toHaveProperty('proposals');
    expect(cases[1].status).toBe(404);
    expect(cases[1].body.error).toBe('ProposalNotFound');
    expect(cases[2].status).toBe(200);
    expect(cases[2].body).toHaveProperty('roles');
    expect(cases[3].status).toBe(200);
    expect(cases[3].body).toHaveProperty('attestations');
    expect(cases[4].status).toBe(200);
    expect(cases[4].body).toEqual({ isMember: false });
  });
});
