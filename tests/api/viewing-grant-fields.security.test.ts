/**
 * A viewing grant that names fields discloses those fields. One that names
 * them badly discloses nothing; it must never widen into the whole claim.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { xrpcAuthPost, createTestUser, isPLCAvailable, uniqueHandle } from './helpers.js';
import { filterGrantedFields } from '../../src/attestation/lifecycle.js';

const claim = { age: 34, country: 'BG', name: 'Elena' };

describe('viewing grant fields', () => {
  it('no restriction recorded means the whole claim', () => {
    expect(filterGrantedFields(claim, null)).toEqual(claim);
    expect(filterGrantedFields(claim, undefined)).toEqual(claim);
  });

  it('a list of fields discloses exactly those', () => {
    expect(filterGrantedFields(claim, ['age'])).toEqual({ age: 34 });
    expect(filterGrantedFields(claim, ['age', 'missing'])).toEqual({ age: 34 });
  });

  it('an empty or unreadable restriction discloses nothing', () => {
    expect(filterGrantedFields(claim, [])).toEqual({});
    expect(filterGrantedFields(claim, 'age')).toEqual({});
    expect(filterGrantedFields(claim, { age: true })).toEqual({});
  });

  it('does not disclose inherited properties', () => {
    expect(filterGrantedFields(claim, ['constructor', 'toString'])).toEqual({});
  });

  describe('createViewingGrant', () => {
    let plc: boolean;
    beforeAll(async () => { plc = await isPLCAvailable(); });

    it('refuses an empty or malformed grantedFields up front', async () => {
      if (!plc) return;
      const user = await createTestUser(uniqueHandle('vgf'));
      for (const grantedFields of [[], 'age', [''], [1, 2], { age: true }]) {
        const res = await xrpcAuthPost('net.openfederation.attestation.createViewingGrant', user.accessJwt, {
          communityDid: 'did:plc:doesnotmatter', rkey: 'x', grantedToDid: 'did:plc:someone', grantedFields,
        });
        expect(res.status, JSON.stringify(grantedFields)).toBe(400);
        expect(res.body.message).toMatch(/grantedFields/);
      }
    });
  });
});
