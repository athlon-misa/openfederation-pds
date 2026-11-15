/**
 * The list of what works while device signing is on (#240), which the
 * dashboard shows as the server reports it (account.getDeviceSigning). Phase 2
 * moved the features that write on the person's behalf to the device; what
 * would still need the server to sign as the person stays unavailable.
 */
import { describe, it, expect } from 'vitest';
import { DEVICE_SIGNING_FEATURES, deviceSigningFeatures } from '../../src/repo/device-signing-features.js';
import { DEVICE_ACTION_METHODS } from '../../src/repo/device-actions.js';

const availability = () => Object.fromEntries(DEVICE_SIGNING_FEATURES.map((f) => [f.id, f.available]));

describe('device signing features (#240)', () => {
  it('lists the features signed on the device as available', () => {
    expect(availability()).toMatchObject({
      'repo.write': true, profile: true, contacts: true, membership: true, governance: true,
      forum: true, 'calendar.rsvp': true, serviceAuth: true, 'signIn.wallet': true,
    });
  });

  it('keeps what would need the server to sign as the person unavailable', () => {
    expect(availability()).toMatchObject({
      externalKeys: false, walletProof: false, remoteActivity: false, delegatedVotes: false,
    });
  });

  it('every method prepareAction takes belongs to an available feature', () => {
    const feature: Record<string, string> = {
      'net.openfederation.account.updateProfile': 'profile',
      'net.openfederation.forum.createThread': 'forum',
      'net.openfederation.forum.createPost': 'forum',
      'net.openfederation.forum.deletePost': 'forum',
      'net.openfederation.calendar.rsvp': 'calendar.rsvp',
      'net.openfederation.community.voteOnProposal': 'governance',
      'net.openfederation.community.objectToProposal': 'governance',
    };
    for (const method of DEVICE_ACTION_METHODS) {
      const id = feature[method] ?? (method.startsWith('net.openfederation.contact.') ? 'contacts' : undefined);
      expect(id, method).toBeDefined();
      expect(availability()[id!], method).toBe(true);
    }
  });

  it('has unique ids and hands out copies', () => {
    const ids = DEVICE_SIGNING_FEATURES.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    const copy = deviceSigningFeatures();
    copy[0].available = !copy[0].available;
    expect(DEVICE_SIGNING_FEATURES[0].available).not.toBe(copy[0].available);
  });
});
