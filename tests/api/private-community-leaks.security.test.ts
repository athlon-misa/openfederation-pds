/**
 * A private community's existence, members and relationships are for its
 * members. Outsiders (signed in or not) get the same "not found" they would
 * get for a DID that does not exist.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import {
  xrpcGet, xrpcAuthPost, xrpcAuthGet, createTestUser, isPLCAvailable, uniqueHandle,
} from './helpers.js';

type User = { accessJwt: string; did: string; handle: string };

describe('private community leaks', () => {
  let plc: boolean;
  let owner: User, outsider: User;
  let privateDid: string;

  beforeAll(async () => {
    plc = await isPLCAvailable();
    if (!plc) return;
    owner = await createTestUser(uniqueHandle('priv-owner'));
    outsider = await createTestUser(uniqueHandle('priv-out'));
    const created = await xrpcAuthPost('net.openfederation.community.create', owner.accessJwt, {
      handle: uniqueHandle('priv'), didMethod: 'plc', visibility: 'private',
    });
    expect(created.status).toBe(201);
    privateDid = created.body.did;
  });

  it('a private community created without a join policy is not open to anyone who knows its DID', async () => {
    if (!plc) return;
    const join = await xrpcAuthPost('net.openfederation.community.join', outsider.accessJwt, { did: privateDid });
    expect(join.body.status).not.toBe('joined');
    const members = await xrpcAuthGet('net.openfederation.community.listMembers', owner.accessJwt, { did: privateDid });
    expect(members.body.members.map((m: any) => m.did)).not.toContain(outsider.did);
  });

  it('rejects unknown visibility and join policy values on create', async () => {
    if (!plc) return;
    const badVisibility = await xrpcAuthPost('net.openfederation.community.create', owner.accessJwt, {
      handle: uniqueHandle('priv'), didMethod: 'plc', visibility: 'secret',
    });
    expect(badVisibility.status).toBe(400);
    const badPolicy = await xrpcAuthPost('net.openfederation.community.create', owner.accessJwt, {
      handle: uniqueHandle('priv'), didMethod: 'plc', joinPolicy: 'whoever',
    });
    expect(badPolicy.status).toBe(400);
  });

  it('answers outsiders exactly as it would for a community that does not exist', async () => {
    if (!plc) return;
    const stranger = await createTestUser(uniqueHandle('priv-stranger'));
    const reads: Array<[string, Record<string, string>]> = [
      ['net.openfederation.community.getDelegation', { communityDid: privateDid, memberDid: owner.did }],
      ['net.openfederation.community.listApplications', { did: privateDid }],
      ['net.openfederation.community.verifyAttestation', { communityDid: privateDid, rkey: 'nothing' }],
      ['net.openfederation.community.listMembers', { did: privateDid }],
    ];
    for (const [nsid, params] of reads) {
      const anon = await xrpcGet(nsid, params);
      // listMembers needs a session for any community, so 401 says nothing about this one.
      expect(anon.status, `${nsid} (anonymous)`).toBe(nsid.endsWith('listMembers') ? 401 : 404);
      const signedIn = await xrpcAuthGet(nsid, stranger.accessJwt, params);
      expect(signedIn.status, `${nsid} (signed in)`).toBe(404);
    }
    const caps = await xrpcAuthGet('net.openfederation.community.myCapabilities', stranger.accessJwt, { communityDid: privateDid });
    expect(caps.status).toBe(404);
  });

  it('still answers its owner', async () => {
    if (!plc) return;
    const del = await xrpcAuthGet('net.openfederation.community.getDelegation', owner.accessJwt, { communityDid: privateDid, memberDid: owner.did });
    expect(del.status).toBe(200);
    const apps = await xrpcAuthGet('net.openfederation.community.listApplications', owner.accessJwt, { did: privateDid });
    expect(apps.status).toBe(200);
    const caps = await xrpcAuthGet('net.openfederation.community.myCapabilities', owner.accessJwt, { communityDid: privateDid });
    expect(caps.status).toBe(200);
  });

  it('an RSVP cannot be attached to an event of a community the caller was not checked against', async () => {
    if (!plc) return;
    const ev = await xrpcAuthPost('net.openfederation.calendar.createEvent', owner.accessJwt, {
      community: privateDid, name: 'Members only',
    });
    expect(ev.status).toBe(200);
    const own = await xrpcAuthPost('net.openfederation.community.create', outsider.accessJwt, {
      handle: uniqueHandle('priv-own'), didMethod: 'plc', visibility: 'public', joinPolicy: 'open',
    });
    const res = await xrpcAuthPost('net.openfederation.calendar.rsvp', outsider.accessJwt, {
      community: own.body.did, event: { uri: ev.body.uri, cid: ev.body.cid }, status: 'going',
    });
    expect(res.status).toBe(400);
    const rsvps = await xrpcAuthGet('net.openfederation.calendar.listRsvps', owner.accessJwt, { event: ev.body.uri });
    expect(rsvps.status).toBe(200);
    expect(JSON.stringify(rsvps.body)).not.toContain(outsider.did);
  });
});
