import { describe, it, expect, beforeAll } from 'vitest';
import {
  xrpcGet, xrpcAuthPost,
  createTestUser, isPLCAvailable, uniqueHandle,
} from './helpers.js';

describe('User Profiles', () => {
  let plcAvailable: boolean;
  let user: { accessJwt: string; did: string; handle: string };

  beforeAll(async () => {
    plcAvailable = await isPLCAvailable();
    if (!plcAvailable) return;
    user = await createTestUser(uniqueHandle('profile'));
  });

  describe('getProfile', () => {
    it('should return a profile for a valid DID', async () => {
      if (!plcAvailable) return;
      const res = await xrpcGet('net.openfederation.account.getProfile', { did: user.did });
      expect(res.status).toBe(200);
      expect(res.body.did).toBe(user.did);
      expect(res.body.profile).toBeTruthy();
      expect(res.body.profile.displayName).toBeTruthy();
    });

    it('should return 404 for unknown DID', async () => {
      const res = await xrpcGet('net.openfederation.account.getProfile', { did: 'did:plc:nonexistent' });
      expect(res.status).toBe(404);
    });

    it('should reject missing did', async () => {
      const res = await xrpcGet('net.openfederation.account.getProfile', {});
      expect(res.status).toBe(400);
    });
  });

  describe('updateProfile', () => {
    it('should reject unauthenticated', async () => {
      const res = await xrpcAuthPost('net.openfederation.account.updateProfile', 'invalid-token', {
        displayName: 'New Name',
      });
      expect(res.status).toBe(401);
    });

    it('should update displayName', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthPost('net.openfederation.account.updateProfile', user.accessJwt, {
        displayName: 'Updated Name',
      });
      expect(res.status).toBe(200);
      expect(res.body.uri).toContain('app.bsky.actor.profile');
    });

    it('should update description', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthPost('net.openfederation.account.updateProfile', user.accessJwt, {
        description: 'A test user bio',
      });
      expect(res.status).toBe(200);
    });

    it('should reflect updates in getProfile', async () => {
      if (!plcAvailable) return;
      const res = await xrpcGet('net.openfederation.account.getProfile', { did: user.did });
      expect(res.status).toBe(200);
      expect(res.body.profile.displayName).toBe('Updated Name');
      expect(res.body.profile.description).toBe('A test user bio');
    });

    it('should write a custom profile collection', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthPost('net.openfederation.account.updateProfile', user.accessJwt, {
        collection: 'app.grvty.actor.profile',
        record: {
          displayName: 'Carlos Martinez',
          bio: 'Goalkeeper for Hackney Youth FC',
          role: 'athlete',
          meta: { position: 'Goalkeeper', number: 1 },
        },
      });
      expect(res.status).toBe(200);
    });

    it('should include custom profiles in getProfile', async () => {
      if (!plcAvailable) return;
      const res = await xrpcGet('net.openfederation.account.getProfile', { did: user.did });
      expect(res.status).toBe(200);
      expect(res.body.customProfiles).toBeTruthy();
      expect(res.body.customProfiles['app.grvty.actor.profile']).toBeTruthy();
      expect(res.body.customProfiles['app.grvty.actor.profile'].role).toBe('athlete');
    });

    it('should reject invalid collection NSID', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthPost('net.openfederation.account.updateProfile', user.accessJwt, {
        collection: 'invalid',
        record: { test: true },
      });
      expect(res.status).toBe(400);
    });
  });
});
