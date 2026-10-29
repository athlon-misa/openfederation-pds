/**
 * E2E (#267): a community with a member, a public and a private
 * attestation moves from PDS A to PDS B. The owner's account stays on A.
 */
import type { AddressInfo } from 'node:net';
import { isPLCAvailable, createTestUser, uniqueHandle, testServer, issuePrivateAttestation } from './helpers.js';
import { xrpcAuthPost, xrpcGet, xrpcAuthGet } from '../api/helpers.js';
import { startSecondPds, type SecondPds } from './second-pds.js';
import { config } from '../../src/config.js';
import { moveCommunity, type CommunityMoveStep } from './community-move.js';

let plc = false;
let pdsA: string;
let pdsB: SecondPds | null = null;

beforeAll(async () => {
  plc = await isPLCAvailable();
  pdsA = `http://127.0.0.1:${(testServer.address() as AddressInfo).port}`;
  if (plc) pdsB = await startSecondPds();
}, 150_000);

afterAll(async () => { await pdsB?.stop(); });

async function json(res: Response) { return res.json().catch(() => ({})); }

describe('community migration', () => {
  it('moves a community from A to B with its members and attestations; A keeps a read-only copy', async (ctx) => {
    if (!plc || !pdsB) ctx.skip('PLC directory not available');
    const owner = await createTestUser(uniqueHandle('cm-owner'));
    const member = await createTestUser(uniqueHandle('cm-member'));
    const created = await xrpcAuthPost('net.openfederation.community.create', owner.accessJwt, {
      handle: uniqueHandle('cm-comm'), didMethod: 'plc', visibility: 'public', joinPolicy: 'open',
    });
    expect(created.status).toBe(201);
    const did = created.body.did as string;
    const primary = created.body.primaryRotationKey as string;
    expect(primary).toBeTruthy();
    expect((await xrpcAuthPost('net.openfederation.community.join', member.accessJwt, { did })).status).toBe(200);
    const pub = await xrpcAuthPost('net.openfederation.community.issueAttestation', owner.accessJwt, {
      communityDid: did, subjectDid: member.did, subjectHandle: member.handle, type: 'membership', claim: { since: '2026' }, visibility: 'public',
    });
    expect(pub.status).toBe(200);
    const priv = await issuePrivateAttestation(owner.accessJwt, did, member.did, member.handle, { secret: 'badge-7' });

    const steps: CommunityMoveStep[] = [];
    const newHandle = created.body.handle.replace(config.handleSuffix, '') as string;
    const moved = await moveCommunity({
      oldPdsUrl: pdsA, newPdsUrl: pdsB!.url, newServiceDid: pdsB!.serviceDid, plcUrl: config.plc.directoryUrl,
      did, ownerDid: owner.did, ownerOldAccessJwt: owner.accessJwt, primaryRotationKeyBase64: primary,
      newHandle, onStep: (s) => steps.push(s),
    });
    expect(steps).toEqual(['open', 'check', 'point', 'activate', 'retire']);
    expect(moved).toMatchObject({ status: 'active', missingAttestationKeys: 0 });

    // The DID names B, B's signing key, the owner's key plus B's recovery key.
    const data = await json(await fetch(`${config.plc.directoryUrl}/${did}/data`));
    expect(data.services.atproto_pds.endpoint).toBe(pdsB!.url);
    expect(data.rotationKeys).toHaveLength(2);
    expect(data.alsoKnownAs).toEqual([`at://${newHandle}${pdsB!.handleSuffix}`]);

    // B: members and attestations are there; the private one can be opened by its subject.
    const status = await json(await fetch(`${pdsB!.url}/xrpc/net.openfederation.community.checkMigration?did=${did}`));
    expect(status).toMatchObject({ status: 'active', validDid: true, members: 2, attestations: 2, missingAttestationKeys: 0 });
    // Reads on B as the owner, whose account is still on A: service auth per method.
    const onB = async (nsid: string, query: Record<string, string>) => {
      const { token } = (await xrpcAuthGet('com.atproto.server.getServiceAuth', owner.accessJwt, { aud: pdsB!.serviceDid, lxm: nsid })).body;
      const res = await fetch(`${pdsB!.url}/xrpc/${nsid}?${new URLSearchParams(query)}`, { headers: { Authorization: `Bearer ${token}` } });
      const body = await json(res);
      return { status: res.status, body };
    };
    const members = await onB('net.openfederation.community.listMembers', { did });
    expect(members.status).toBe(200);
    expect(members.body.members.map((m: { did: string }) => m.did)).toEqual(expect.arrayContaining([owner.did, member.did]));
    const atts = await onB('net.openfederation.community.listAttestations', { communityDid: did });
    expect(atts.status).toBe(200);
    expect(atts.body.attestations).toHaveLength(2);
    const memberToken = (await xrpcAuthGet('com.atproto.server.getServiceAuth', member.accessJwt, { aud: pdsB!.serviceDid, lxm: 'net.openfederation.attestation.requestDisclosure' })).body.token;
    const disclosed = await fetch(`${pdsB!.url}/xrpc/net.openfederation.attestation.requestDisclosure`, {
      method: 'POST', headers: { Authorization: `Bearer ${memberToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ communityDid: did, rkey: priv.rkey, purpose: 'checking after the move' }),
    });
    expect(disclosed.status).toBe(200);
    expect((await json(disclosed)).ciphertext).toBeTruthy();

    // The owner, still on A, administers the community on B through service auth.
    const ownerToken = (await xrpcAuthGet('com.atproto.server.getServiceAuth', owner.accessJwt, { aud: pdsB!.serviceDid, lxm: 'net.openfederation.community.update' })).body.token;
    const updated = await fetch(`${pdsB!.url}/xrpc/net.openfederation.community.update`, {
      method: 'POST', headers: { Authorization: `Bearer ${ownerToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ did, description: 'Now hosted on B' }),
    });
    expect(updated.status).toBe(200);

    // A: the copy is moved and read-only.
    const onA = await xrpcGet('net.openfederation.community.get', { did });
    expect(onA.body.status).toBe('moved');
    const write = await xrpcAuthPost('net.openfederation.community.update', owner.accessJwt, { did, description: 'stale' });
    expect(write.status).toBe(403);
    expect(write.body.error).toBe('CommunityMoved');
  });
});
