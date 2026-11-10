/**
 * Who may issue which kind of attestation is policy, set on the role and so
 * decided the way the community decides things. Issuing one within that policy
 * is routine and needs no vote.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { xrpcAuthPost, xrpcAuthGet, createTestUser, isPLCAvailable, uniqueHandle } from './helpers.js';

type User = { accessJwt: string; did: string; handle: string };

describe('attestation issuance policy', () => {
  let plc: boolean;
  let owner: User, issuer: User, subject: User;
  let communityDid: string;
  let issuerRole: string;

  const issue = (who: User, type: string) => xrpcAuthPost('net.openfederation.community.issueAttestation', who.accessJwt, {
    communityDid, subjectDid: subject.did, subjectHandle: subject.handle, type, claim: { note: type },
  });

  beforeAll(async () => {
    plc = await isPLCAvailable();
    if (!plc) return;
    owner = await createTestUser(uniqueHandle('aip-owner'));
    issuer = await createTestUser(uniqueHandle('aip-issuer'));
    subject = await createTestUser(uniqueHandle('aip-subject'));
    const created = await xrpcAuthPost('net.openfederation.community.create', owner.accessJwt, {
      handle: uniqueHandle('aip'), didMethod: 'plc', visibility: 'public', joinPolicy: 'open',
    });
    communityDid = created.body.did;
    for (const u of [issuer, subject]) await xrpcAuthPost('net.openfederation.community.join', u.accessJwt, { did: communityDid });

    const role = await xrpcAuthPost('net.openfederation.community.createRole', owner.accessJwt, {
      communityDid, name: 'registrar',
      permissions: ['community.member.read', 'community.attestation.write', 'community.attestation.delete'],
      attestationTypes: ['membership'],
    });
    expect(role.status).toBe(200);
    issuerRole = role.body.rkey ?? role.body.uri.split('/').pop();
    const assigned = await xrpcAuthPost('net.openfederation.community.updateMember', owner.accessJwt, {
      communityDid, memberDid: issuer.did, roleRkey: issuerRole,
    });
    expect(assigned.status).toBe(200);
  });

  it('a role limited to some attestation types can issue those and no others', async () => {
    if (!plc) return;
    expect((await issue(issuer, 'membership')).status).toBe(200);
    const refused = await issue(issuer, 'credential');
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe('AttestationTypeNotAllowed');
  });

  it('the same limit applies to revoking', async () => {
    if (!plc) return;
    const byOwner = await issue(owner, 'credential');
    expect(byOwner.status).toBe(200);
    const refused = await xrpcAuthPost('net.openfederation.community.deleteAttestation', issuer.accessJwt, {
      communityDid, rkey: byOwner.body.rkey,
    });
    expect(refused.status).toBe(403);
    const own = await issue(issuer, 'membership');
    const allowed = await xrpcAuthPost('net.openfederation.community.deleteAttestation', issuer.accessJwt, {
      communityDid, rkey: own.body.rkey,
    });
    expect(allowed.status).toBe(200);
  });

  it('a role with no type list may issue every type, as before', async () => {
    if (!plc) return;
    expect((await issue(owner, 'role')).status).toBe(200);
  });

  it('rejects an attestation type list that names unknown types', async () => {
    if (!plc) return;
    const res = await xrpcAuthPost('net.openfederation.community.createRole', owner.accessJwt, {
      communityDid, name: 'bad-types', permissions: ['community.attestation.write'], attestationTypes: ['diploma'],
    });
    expect(res.status).toBe(400);
  });

  describe('once the community decides by vote', () => {
    beforeAll(async () => {
      if (!plc) return;
      const res = await xrpcAuthPost('net.openfederation.community.setGovernanceModel', owner.accessJwt, {
        communityDid, governanceModel: 'simple-majority',
        governanceConfig: { quorum: 1, voterRole: 'moderator', proposalTtlDays: 7, timelockHours: 0 },
      });
      expect(res.status).toBe(200);
    });

    it('issuing within the policy still needs no proposal', async () => {
      if (!plc) return;
      expect((await issue(issuer, 'membership')).status).toBe(200);
    });

    it('changing the policy does: the role cannot be widened without a vote', async () => {
      if (!plc) return;
      const res = await xrpcAuthPost('net.openfederation.community.updateRole', owner.accessJwt, {
        communityDid, rkey: issuerRole, attestationTypes: ['membership', 'role', 'credential'],
      });
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('GovernanceDenied');
      expect((await issue(issuer, 'credential')).status).toBe(403);
    });

    it('lists the policy with the role', async () => {
      if (!plc) return;
      const roles = await xrpcAuthGet('net.openfederation.community.listRoles', owner.accessJwt, { communityDid });
      const registrar = roles.body.roles.find((r: any) => r.name === 'registrar');
      expect(registrar.attestationTypes).toEqual(['membership']);
    });
  });
});
