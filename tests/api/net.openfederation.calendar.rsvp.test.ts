import { describe, it, expect, beforeAll } from 'vitest';
import { createTestUser, isPLCAvailable, uniqueHandle, xrpcAuthPost, xrpcGet } from './helpers.js';

describe('calendar rsvp', () => {
  let plc: boolean;
  beforeAll(async () => { plc = await isPLCAvailable(); });

  it('member RSVPs and counts aggregate', async () => {
    if (!plc) return;
    const owner = await createTestUser(uniqueHandle('rs-owner'));
    const create = await xrpcAuthPost('net.openfederation.community.create', owner.accessJwt, {
      handle: uniqueHandle('rs-comm'), didMethod: 'plc', visibility: 'public', joinPolicy: 'open',
    });
    const communityDid = create.body.did;
    const ev = await xrpcAuthPost('net.openfederation.calendar.createEvent', owner.accessJwt, {
      community: communityDid, name: 'Meetup',
    });

    const rsvp = await xrpcAuthPost('net.openfederation.calendar.rsvp', owner.accessJwt, {
      community: communityDid, event: { uri: ev.body.uri, cid: ev.body.cid }, status: 'going',
    });
    expect(rsvp.status).toBe(200);
    expect(rsvp.body).toHaveProperty('uri');
    expect(rsvp.body).toHaveProperty('cid');
    expect(rsvp.body).toHaveProperty('rkey');

    const list = await xrpcGet('net.openfederation.calendar.listRsvps', { event: ev.body.uri });
    expect(list.status).toBe(200);
    expect(list.body.counts.going).toBe(1);
    expect(list.body.counts.interested).toBe(0);
    expect(list.body.counts.notgoing).toBe(0);
    expect(list.body.rsvps).toHaveLength(1);
  });

  it('returns 400 when status is invalid', async () => {
    if (!plc) return;
    const owner = await createTestUser(uniqueHandle('rs-invalid'));
    const create = await xrpcAuthPost('net.openfederation.community.create', owner.accessJwt, {
      handle: uniqueHandle('rs-inv-comm'), didMethod: 'plc', visibility: 'public', joinPolicy: 'open',
    });
    const communityDid = create.body.did;
    const ev = await xrpcAuthPost('net.openfederation.calendar.createEvent', owner.accessJwt, {
      community: communityDid, name: 'Bad RSVP Event',
    });

    const rsvp = await xrpcAuthPost('net.openfederation.calendar.rsvp', owner.accessJwt, {
      community: communityDid, event: { uri: ev.body.uri, cid: ev.body.cid }, status: 'maybe',
    });
    expect(rsvp.status).toBe(400);
  });

  it('listRsvps returns 400 without event param', async () => {
    const list = await xrpcGet('net.openfederation.calendar.listRsvps', {});
    expect(list.status).toBe(400);
  });
});
