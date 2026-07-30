import { beforeAll, describe, expect, it } from 'vitest';
import { api, getAdminToken, isPLCAvailable, uniqueHandle, xrpcAuthPost } from './helpers.js';
import { query } from '../../src/db/client.js';

describe('partner registration quota', () => {
  let plc: boolean;
  beforeAll(async () => { plc = await isPLCAvailable(); });

  it('allows only one concurrent registration at a one-per-hour quota', async () => {
    if (!plc) return;
    const created = await xrpcAuthPost('net.openfederation.partner.createKey', await getAdminToken(), {
      name: uniqueHandle('partner'),
      partnerName: 'Quota Test',
      allowedOrigins: ['https://quota.test'],
      rateLimitPerHour: 1,
      permissions: ['register'],
    });
    expect(created.status).toBe(201);
    await query("UPDATE partner_keys SET verification_state = 'verified' WHERE id = $1", [created.body.id]);
    const register = (suffix: string) => api
      .post('/xrpc/net.openfederation.partner.register')
      .set('X-Partner-Key', created.body.key)
      .set('Origin', 'https://quota.test')
      .send({
        handle: uniqueHandle(`quota-${suffix}`),
        email: `quota-${suffix}-${Date.now()}@test.local`,
        password: 'TestPassword123!',
      });

    const results = await Promise.all([register('one'), register('two')]);
    expect(results.filter((result) => result.status === 201)).toHaveLength(1);
    expect(results.filter((result) => result.status === 429)).toHaveLength(1);
  });
});
