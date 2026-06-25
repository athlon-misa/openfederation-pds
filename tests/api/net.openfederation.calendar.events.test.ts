import { describe, it, expect, beforeAll } from 'vitest';
import { createTestUser, isPLCAvailable, uniqueHandle, xrpcAuthPost, xrpcGet } from './helpers.js';

describe('calendar events', () => {
  let plc: boolean;
  beforeAll(async () => { plc = await isPLCAvailable(); });

  it('owner creates an event in the community repo; it lists', async () => {
    if (!plc) return;
    const owner = await createTestUser(uniqueHandle('ce-owner'));
    const create = await xrpcAuthPost('net.openfederation.community.create', owner.accessJwt, {
      handle: uniqueHandle('ce-comm'), didMethod: 'plc', visibility: 'public', joinPolicy: 'open',
    });
    const communityDid = create.body.did;

    const ev = await xrpcAuthPost('net.openfederation.calendar.createEvent', owner.accessJwt, {
      community: communityDid, name: 'Launch Party', startsAt: '2026-07-01T18:00:00Z', mode: 'inperson',
    });
    expect(ev.status).toBe(200);
    expect(ev.body.uri).toContain('community.lexicon.calendar.event');

    const list = await xrpcGet('net.openfederation.calendar.listEvents', { community: communityDid });
    expect(list.status).toBe(200);
    expect(list.body.events.map((e: { uri: string }) => e.uri)).toContain(ev.body.uri);
  });
});
