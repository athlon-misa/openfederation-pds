import { describe, it, expect, beforeAll } from 'vitest';
import http from 'node:http';
import { api, xrpcAuthPost, getAdminToken, uniqueHandle } from './helpers.js';

describe('Partner key domain-ownership verification (issue #48)', () => {
  let adminToken: string;

  beforeAll(async () => {
    adminToken = await getAdminToken();
  });

  it('createKey returns pending state + verification instructions', async () => {
    const res = await xrpcAuthPost('net.openfederation.partner.createKey', adminToken, {
      name: 'test-' + uniqueHandle('key'),
      partnerName: 'Test Partner',
      allowedOrigins: ['https://example.com'],
    });
    expect(res.status).toBe(201);
    expect(res.body.verificationState).toBe('pending');
    expect(res.body.verification).toBeDefined();
    expect(typeof res.body.verification.token).toBe('string');
    expect(res.body.verification.wellKnownPath).toBe('/.well-known/openfederation-partner.json');
    expect(res.body.verification.wellKnownBody.token).toBe(res.body.verification.token);
  });

  it('pending key is rejected by partner.register with PartnerKeyUnverified', async () => {
    const createRes = await xrpcAuthPost('net.openfederation.partner.createKey', adminToken, {
      name: 'test-' + uniqueHandle('unverified'),
      partnerName: 'Unverified Partner',
      allowedOrigins: ['https://unverified-partner.test'],
    });
    expect(createRes.status).toBe(201);
    const rawKey = createRes.body.key;

    const regRes = await api
      .post('/xrpc/net.openfederation.partner.register')
      .set('X-Partner-Key', rawKey)
      .set('Origin', 'https://unverified-partner.test')
      .send({
        handle: uniqueHandle('u'),
        email: `${uniqueHandle('u')}@test.local`,
        password: 'Passw0rd!Passw0rd!',
      });

    expect(regRes.status).toBe(403);
    expect(regRes.body.error).toBe('PartnerKeyUnverified');
  });

  it('verifyKey fails cleanly when well-known fetch returns 404', async () => {
    // Spin up a localhost origin that returns 404 for the well-known path.
    // isPrivateHost guards against this — we expect the "private host" failure
    // reason, which still blocks verification as intended.
    const server = http.createServer((_req, res) => {
      res.statusCode = 404;
      res.end('not found');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address() as { port: number };
    const origin = `http://127.0.0.1:${addr.port}`;

    try {
      const createRes = await xrpcAuthPost('net.openfederation.partner.createKey', adminToken, {
        name: 'test-' + uniqueHandle('404'),
        partnerName: '404 Test',
        allowedOrigins: [origin],
      });
      expect(createRes.status).toBe(201);

      const verifyRes = await xrpcAuthPost('net.openfederation.partner.verifyKey', adminToken, {
        id: createRes.body.id,
      });
      expect(verifyRes.status).toBe(400);
      expect(verifyRes.body.error).toBe('VerificationFailed');
      expect(Array.isArray(verifyRes.body.results)).toBe(true);
      expect(verifyRes.body.results[0].ok).toBe(false);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    }
  });

  it('verifyKey short-circuits when already verified', async () => {
    // Grandfathered keys (inserted with verification_state='verified' via
    // migration default) should be idempotent: calling verifyKey on a
    // verified row returns {alreadyVerified: true} with no network fetches.
    const { query } = await import('../../src/db/client.js');
    const { randomUUID } = await import('crypto');
    const id = randomUUID();
    await query(
      `INSERT INTO partner_keys
         (id, key_hash, key_prefix, name, partner_name, permissions,
          allowed_origins, rate_limit_per_hour, verification_state)
       VALUES ($1, $2, 'ofp_stub', 'grandfathered', 'Pre-#48 Partner',
               '["register"]'::jsonb, '["https://grandfathered.test"]'::jsonb,
               100, 'verified')`,
      [id, 'stub-hash-' + id],
    );
    const res = await xrpcAuthPost('net.openfederation.partner.verifyKey', adminToken, { id });
    expect(res.status).toBe(200);
    expect(res.body.verificationState).toBe('verified');
    expect(res.body.alreadyVerified).toBe(true);
  });
});
