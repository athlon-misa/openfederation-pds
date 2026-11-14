/**
 * GET /tls-check?domain=<name> (#405): the question a reverse proxy with
 * on-demand TLS (Caddy's `on_demand_tls { ask ... }`) asks before it fetches
 * a certificate for a name under the handle domain. 200 only for a name that
 * is one of this server's own handles; anything else 404, so nobody can make
 * the proxy request certificates for arbitrary names.
 */
import { describe, it, expect } from 'vitest';
import { api, getAdminToken, getAdminHandle } from './helpers.js';

describe('GET /tls-check', () => {
  it('allows a certificate for one of this server\'s own handles', async () => {
    await getAdminToken();
    const res = await api.get('/tls-check').query({ domain: `${getAdminHandle()}.openfederation.net` });
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toMatch(/no-store/);
  });

  it('matches the name case-insensitively and ignores a trailing dot', async () => {
    await getAdminToken();
    const res = await api.get('/tls-check').query({ domain: `${getAdminHandle().toUpperCase()}.OpenFederation.net.` });
    expect(res.status).toBe(200);
  });

  it('refuses names that are not handles here', async () => {
    const handle = getAdminHandle();
    for (const domain of [
      'nobody-here-at-all.openfederation.net',
      `${handle}.elsewhere.example`,
      `a.${handle}.openfederation.net`,
      'openfederation.net',
      '',
      'x'.repeat(300) + '.openfederation.net',
    ]) {
      expect((await api.get('/tls-check').query({ domain })).status, domain).toBe(404);
    }
    expect((await api.get('/tls-check')).status).toBe(404);
  });
});
