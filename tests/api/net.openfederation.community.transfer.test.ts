/**
 * community.transfer re-authenticates the owner with their password (#260).
 *
 * The handler always required `password`, but the lexicon declared only
 * `did`, so the runtime refused the field and no request could succeed.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { xrpcAuthPost, createTestUser, isPLCAvailable, uniqueHandle } from './helpers.js';
import { query } from '../../src/db/client.js';

type User = { accessJwt: string; did: string; handle: string };

const PASSWORD = 'TestPassword123!';

describe('net.openfederation.community.transfer', () => {
  let plcAvailable: boolean;
  let owner: User;
  let other: User;
  let communityDid: string;

  beforeAll(async () => {
    plcAvailable = await isPLCAvailable();
    if (!plcAvailable) return;

    owner = await createTestUser(uniqueHandle('tr-owner'));
    other = await createTestUser(uniqueHandle('tr-other'));
    const created = await xrpcAuthPost('net.openfederation.community.create', owner.accessJwt, {
      handle: uniqueHandle('tr-comm'),
      didMethod: 'plc',
    });
    expect(created.status).toBe(201);
    communityDid = created.body.did;
  });

  it('gives the owner the transfer package when the password is right', async () => {
    if (!plcAvailable) return;
    const res = await xrpcAuthPost('net.openfederation.community.transfer', owner.accessJwt, {
      did: communityDid,
      password: PASSWORD,
    });
    expect(res.status).toBe(200);
    expect(res.body.community.did).toBe(communityDid);
    expect(typeof res.body.transferToken).toBe('string');
    expect(res.body.stats.totalRecords).toBeGreaterThan(0);
  });

  it('refuses a missing password', async () => {
    if (!plcAvailable) return;
    const res = await xrpcAuthPost('net.openfederation.community.transfer', owner.accessJwt, { did: communityDid });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('InvalidRequest');
  });

  it('refuses a wrong password', async () => {
    if (!plcAvailable) return;
    const res = await xrpcAuthPost('net.openfederation.community.transfer', owner.accessJwt, {
      did: communityDid,
      password: 'Wrong-Password-1!',
    });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Unauthorized');
  });

  it('refuses anyone but the owner', async () => {
    if (!plcAvailable) return;
    const res = await xrpcAuthPost('net.openfederation.community.transfer', other.accessJwt, {
      did: communityDid,
      password: PASSWORD,
    });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Forbidden');
  });

  it('refuses a taken-down community', async () => {
    if (!plcAvailable) return;
    await query("UPDATE communities SET status = 'takendown' WHERE did = $1", [communityDid]);
    try {
      const res = await xrpcAuthPost('net.openfederation.community.transfer', owner.accessJwt, {
        did: communityDid,
        password: PASSWORD,
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('CommunityTakenDown');
    } finally {
      await query("UPDATE communities SET status = 'active' WHERE did = $1", [communityDid]);
    }
  });
});
