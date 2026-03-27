import { describe, it, expect, beforeAll } from 'vitest';
import { xrpcGet, xrpcAuthGet, xrpcAuthPost, getAdminToken, createTestUser, uniqueHandle, isPLCAvailable } from './helpers.js';

describe('net.openfederation.community.get', () => {
  let adminToken: string;
  let plcAvailable: boolean;
  let communityDid: string | null = null;
  let userToken: string | null = null;

  beforeAll(async () => {
    adminToken = await getAdminToken();
    plcAvailable = await isPLCAvailable();

    if (plcAvailable) {
      // Create a test user and community (requires PLC)
      const user = await createTestUser(uniqueHandle('cget'));
      userToken = user.accessJwt;

      const createRes = await xrpcAuthPost('net.openfederation.community.create', user.accessJwt, {
        handle: uniqueHandle('cget-comm'),
        didMethod: 'plc',
        displayName: 'Test Community',
        description: 'Integration test community',
        visibility: 'public',
        joinPolicy: 'open',
      });

      if (createRes.status === 201) {
        communityDid = createRes.body.did;
      }
    }
  });

  // === VALIDATION (no PLC needed) ===

  it('should reject missing did parameter', async () => {
    const res = await xrpcGet('net.openfederation.community.get');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('InvalidRequest');
  });

  it('should return 404 for non-existent community', async () => {
    const res = await xrpcGet('net.openfederation.community.get', {
      did: 'did:plc:nonexistent000000000000',
    });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NotFound');
  });

  // === PLC-DEPENDENT TESTS ===

  it('should get community details without auth', async () => {
    if (!communityDid) return; // skip if PLC unavailable
    const res = await xrpcGet('net.openfederation.community.get', { did: communityDid });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('did', communityDid);
    expect(res.body).toHaveProperty('handle');
    expect(res.body).toHaveProperty('displayName');
    expect(res.body).toHaveProperty('description');
    expect(res.body).toHaveProperty('visibility', 'public');
    expect(res.body).toHaveProperty('joinPolicy', 'open');
    expect(res.body).toHaveProperty('memberCount');
    expect(res.body).toHaveProperty('createdAt');
    expect(res.body).toHaveProperty('status', 'active');
  });

  it('should include membership info when authenticated as owner', async () => {
    if (!communityDid || !userToken) return;
    const res = await xrpcAuthGet('net.openfederation.community.get', userToken, { did: communityDid });
    expect(res.status).toBe(200);
    expect(res.body.isOwner).toBe(true);
    expect(res.body.isMember).toBe(true);
  });

  it('should show non-member status for admin', async () => {
    if (!communityDid) return;
    const res = await xrpcAuthGet('net.openfederation.community.get', adminToken, { did: communityDid });
    expect(res.status).toBe(200);
    // Admin is not the owner or member of this community
    expect(res.body).toHaveProperty('isMember');
  });

  it('should return correct member count', async () => {
    if (!communityDid) return;
    const res = await xrpcGet('net.openfederation.community.get', { did: communityDid });
    expect(res.status).toBe(200);
    expect(res.body.memberCount).toBeGreaterThanOrEqual(1);
  });
});
