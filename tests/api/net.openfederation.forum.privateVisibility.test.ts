import { describe, it, expect, beforeAll } from 'vitest';
import { createTestUser, isPLCAvailable, uniqueHandle, xrpcAuthPost, xrpcAuthGet, xrpcGet } from './helpers.js';

/**
 * Private communities must not leak their forum threads/posts, calendar
 * events, or RSVP member lists to non-members. Writes were already gated by
 * community.forum.write / community.calendar.write (membership), but the read
 * endpoints previously skipped the visibility check that community.get and
 * listMembers enforce. These tests lock the read gate in place.
 */
describe('private community forum/calendar read visibility', () => {
  let plc: boolean;
  let owner: { accessJwt: string; did: string };
  let outsider: { accessJwt: string; did: string };
  let communityDid: string;
  let threadUri: string;
  let eventUri: string;

  beforeAll(async () => {
    plc = await isPLCAvailable();
    if (!plc) return;
    owner = await createTestUser(uniqueHandle('pv-owner'));
    outsider = await createTestUser(uniqueHandle('pv-outsider'));
    const create = await xrpcAuthPost('net.openfederation.community.create', owner.accessJwt, {
      handle: uniqueHandle('pv-comm'), didMethod: 'plc', visibility: 'private', joinPolicy: 'approval',
    });
    communityDid = create.body.did;
    const thread = await xrpcAuthPost('net.openfederation.forum.createThread', owner.accessJwt, {
      community: communityDid, title: 'private thread',
    });
    threadUri = thread.body.uri;
    const event = await xrpcAuthPost('net.openfederation.calendar.createEvent', owner.accessJwt, {
      community: communityDid, name: 'private event',
    });
    eventUri = event.body.uri;
    await xrpcAuthPost('net.openfederation.calendar.rsvp', owner.accessJwt, {
      community: communityDid, event: { uri: eventUri, cid: event.body.cid }, status: 'going',
    });
  });

  it('owner can read the private community forum', async () => {
    if (!plc) return;
    const list = await xrpcAuthGet('net.openfederation.forum.listThreads', owner.accessJwt, { community: communityDid });
    expect(list.status).toBe(200);
    expect(list.body.threads.map((t: { uri: string }) => t.uri)).toContain(threadUri);

    const get = await xrpcAuthGet('net.openfederation.forum.getThread', owner.accessJwt, { uri: threadUri });
    expect(get.status).toBe(200);
  });

  it('non-member cannot list threads of a private community (404)', async () => {
    if (!plc) return;
    const anon = await xrpcGet('net.openfederation.forum.listThreads', { community: communityDid });
    expect(anon.status).toBe(404);

    const outsiderView = await xrpcAuthGet('net.openfederation.forum.listThreads', outsider.accessJwt, { community: communityDid });
    expect(outsiderView.status).toBe(404);
  });

  it('non-member cannot getThread in a private community (404)', async () => {
    if (!plc) return;
    const anon = await xrpcGet('net.openfederation.forum.getThread', { uri: threadUri });
    expect(anon.status).toBe(404);

    const outsiderView = await xrpcAuthGet('net.openfederation.forum.getThread', outsider.accessJwt, { uri: threadUri });
    expect(outsiderView.status).toBe(404);
  });

  it('non-member cannot list events of a private community (404)', async () => {
    if (!plc) return;
    const anon = await xrpcGet('net.openfederation.calendar.listEvents', { community: communityDid });
    expect(anon.status).toBe(404);

    const outsiderView = await xrpcAuthGet('net.openfederation.calendar.listEvents', outsider.accessJwt, { community: communityDid });
    expect(outsiderView.status).toBe(404);
  });

  it('non-member cannot list RSVP member lists of a private community (404)', async () => {
    if (!plc) return;
    const anon = await xrpcGet('net.openfederation.calendar.listRsvps', { event: eventUri });
    expect(anon.status).toBe(404);

    const outsiderView = await xrpcAuthGet('net.openfederation.calendar.listRsvps', outsider.accessJwt, { event: eventUri });
    expect(outsiderView.status).toBe(404);
  });

  it('owner can still read events and RSVPs', async () => {
    if (!plc) return;
    const events = await xrpcAuthGet('net.openfederation.calendar.listEvents', owner.accessJwt, { community: communityDid });
    expect(events.status).toBe(200);
    expect(events.body.events.map((e: { uri: string }) => e.uri)).toContain(eventUri);

    const rsvps = await xrpcAuthGet('net.openfederation.calendar.listRsvps', owner.accessJwt, { event: eventUri });
    expect(rsvps.status).toBe(200);
    expect(rsvps.body.counts.going).toBeGreaterThanOrEqual(1);
  });

  // Generic ATProto repo endpoints must not leak a private community's repo.
  const MEMBER_COLLECTION = 'net.openfederation.community.member';

  it('non-member cannot enumerate a private community repo via com.atproto.repo.listRecords (404)', async () => {
    if (!plc) return;
    const anon = await xrpcGet('com.atproto.repo.listRecords', { repo: communityDid, collection: MEMBER_COLLECTION });
    expect(anon.status).toBe(404);

    const outsiderView = await xrpcAuthGet('com.atproto.repo.listRecords', outsider.accessJwt, { repo: communityDid, collection: MEMBER_COLLECTION });
    expect(outsiderView.status).toBe(404);
  });

  it('non-member cannot describeRepo or sync.getRepo a private community (404)', async () => {
    if (!plc) return;
    const describe = await xrpcGet('com.atproto.repo.describeRepo', { repo: communityDid });
    expect(describe.status).toBe(404);

    const car = await xrpcGet('com.atproto.sync.getRepo', { did: communityDid });
    expect(car.status).toBe(404);
  });

  it('owner can still read the private community repo via com.atproto.repo.listRecords', async () => {
    if (!plc) return;
    const ownerView = await xrpcAuthGet('com.atproto.repo.listRecords', owner.accessJwt, { repo: communityDid, collection: MEMBER_COLLECTION });
    expect(ownerView.status).toBe(200);
  });

  it('regression: a PUBLIC community repo stays readable by anyone (ATProto public)', async () => {
    if (!plc) return;
    const pubOwner = await createTestUser(uniqueHandle('pv-pub'));
    const pub = await xrpcAuthPost('net.openfederation.community.create', pubOwner.accessJwt, {
      handle: uniqueHandle('pv-pubcomm'), didMethod: 'plc', visibility: 'public', joinPolicy: 'open',
    });
    const anon = await xrpcGet('com.atproto.repo.listRecords', { repo: pub.body.did, collection: MEMBER_COLLECTION });
    expect(anon.status).toBe(200);
    const describe = await xrpcGet('com.atproto.repo.describeRepo', { repo: pub.body.did });
    expect(describe.status).toBe(200);
  });

  it('regression: a user repo (non-community DID) is unaffected by the community gate', async () => {
    if (!plc) return;
    // owner.did is a user DID, not a community — repo endpoints must not 404 it.
    const describe = await xrpcGet('com.atproto.repo.describeRepo', { repo: owner.did });
    expect(describe.status).toBe(200);
  });
});
